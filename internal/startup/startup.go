// Package startup manages only this user's MyScreen login startup values.
// Nothing runs automatically. Configure must be called only after successful
// configuration loading/validation, never after a corrupt-config fallback.
package startup

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

const (
	RunKey             = `Software\Microsoft\Windows\CurrentVersion\Run`
	ApprovedKey        = `Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`
	AppName            = "MyScreen"
	priorName          = "MonitorsFocus"
	LegacyName         = "MonitorsFocus.ControlCenter"
	Arguments          = "--mode native --hardware --production --background"
	stringType  uint32 = 1 // REG_SZ
	binaryType  uint32 = 3 // REG_BINARY
)

// Value preserves arbitrary registry types and raw bytes for exact rollback.
// Read distinguishes an absent key from an absent value in an existing key.
type Value struct {
	KeyExists bool
	Exists    bool
	Type      uint32
	Data      []byte
}

// Registry enables in-memory tests. Missing reads/deletes succeed with an absent
// Value; permission/other failures must propagate. Write may create a key.
type Registry interface {
	Read(key, name string) (Value, error)
	Write(key, name string, kind uint32, data []byte) error
	Delete(key, name string) error
}

type entry struct{ key, name string }

const priorApproval = 3

var entries = [...]entry{
	{RunKey, AppName}, {ApprovedKey, AppName},
	{RunKey, priorName}, {ApprovedKey, priorName},
	{RunKey, LegacyName}, {ApprovedKey, LegacyName},
}

// State is an opaque snapshot of the owned values, not entire shared keys.
// Restore preserves other applications' entries. A zero State is invalid.
type State struct {
	values [len(entries)]Value
	valid  bool
}

// Manager serializes operations on one injected registry. The Windows package
// functions share one Manager. Do not copy a Manager or call it concurrently
// through multiple instances against the same real registry.
type Manager struct {
	registry Registry
	mu       sync.Mutex
	now      func() time.Time
}

func NewManager(registry Registry) *Manager { return &Manager{registry: registry, now: time.Now} }

func (m *Manager) Snapshot() (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshot()
}

func (m *Manager) snapshot() (State, error) {
	if m.registry == nil {
		return State{}, errors.New("startup registry is nil")
	}
	state := State{valid: true}
	for i, e := range entries {
		v, err := m.registry.Read(e.key, e.name)
		if err != nil {
			return State{}, fmt.Errorf("snapshot %s/%s: %w", e.key, e.name, err)
		}
		if v.Exists && !v.KeyExists {
			return State{}, errors.New("inconsistent startup registry value")
		}
		v.Data = slices.Clone(v.Data)
		state.values[i] = v
	}
	return state, nil
}

// Command validates a real absolute .exe file and quotes it as one Windows
// executable argument. It neither expands environment variables nor runs a shell.
func Command(executablePath string) (string, error) {
	if !filepath.IsAbs(executablePath) || strings.ContainsAny(executablePath, "\"\x00\r\n") {
		return "", errors.New("startup executable must be an unquoted absolute path")
	}
	path := filepath.Clean(executablePath)
	if !strings.EqualFold(filepath.Ext(path), ".exe") {
		return "", errors.New("startup executable must be an .exe file")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("startup executable: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("startup executable must be a regular file")
	}
	return `"` + path + `" ` + Arguments, nil
}

// Configure validates the executable even when disabling, snapshots all owned
// values before mutation, removes the historical alias, verifies the result,
// and attempts exact value rollback on any failure (including partial writes).
// Only call after config load/validation succeeds and adoption is authorized.
func (m *Manager) Configure(executablePath string, enabled bool) error {
	command, err := Command(executablePath)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	before, err := m.snapshot()
	if err != nil {
		return err
	}
	next := State{valid: true}
	if enabled {
		next.values[0] = Value{KeyExists: true, Exists: true, Type: stringType, Data: stringBytes(command)}
		approved := before.values[1]
		if !approved.Exists && before.values[priorApproval].Exists {
			approved = before.values[priorApproval]
		}
		// Explorer owns this key. If absent, a new Run value is enabled by
		// Windows; do not create an undocumented approval key just for us.
		if approved.KeyExists {
			if approved.Exists && approved.Type == binaryType && len(approved.Data) > 0 && approved.Data[0] == 2 {
				next.values[1] = approved // preserve exact enabled bytes/timestamp
			} else {
				data := make([]byte, 12)
				data[0] = 2
				now := m.now().UTC()
				filetime := uint64(now.Unix()+11644473600)*10000000 + uint64(now.Nanosecond()/100)
				binary.LittleEndian.PutUint64(data[4:], filetime)
				next.values[1] = Value{KeyExists: true, Exists: true, Type: binaryType, Data: data}
			}
		}
	}
	return m.apply(before, next)
}

// Restore reinstates the exact types/bytes/absence from a prior Snapshot.
// Restore is itself rollback-protected: failure attempts to reinstate the state
// immediately before Restore. Empty shared keys are deliberately never deleted.
func (m *Manager) Restore(state State) error {
	if !state.valid {
		return errors.New("invalid startup snapshot")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	before, err := m.snapshot()
	if err != nil {
		return err
	}
	return m.apply(before, state)
}

func sameValue(a, b Value) bool {
	return a.Exists == b.Exists && (!a.Exists || (a.Type == b.Type && bytes.Equal(a.Data, b.Data)))
}

func (m *Manager) put(i int, value Value) error {
	e := entries[i]
	if !value.Exists {
		return m.registry.Delete(e.key, e.name)
	}
	return m.registry.Write(e.key, e.name, value.Type, slices.Clone(value.Data))
}

func (m *Manager) verify(expected State) error {
	actual, err := m.snapshot()
	if err != nil {
		return err
	}
	for i := range entries {
		if !sameValue(actual.values[i], expected.values[i]) {
			return fmt.Errorf("startup readback mismatch: %s/%s", entries[i].key, entries[i].name)
		}
	}
	return nil
}

func (m *Manager) apply(before, next State) error {
	attempted := []int{}
	for i := range entries {
		if sameValue(before.values[i], next.values[i]) {
			continue
		}
		attempted = append(attempted, i) // failing writes may have partially mutated
		if err := m.put(i, next.values[i]); err != nil {
			return m.rollback(before, attempted, fmt.Errorf("configure %s/%s: %w", entries[i].key, entries[i].name, err))
		}
	}
	if err := m.verify(next); err != nil {
		return m.rollback(before, attempted, err)
	}
	return nil
}

func (m *Manager) rollback(before State, attempted []int, cause error) error {
	var failures []error
	for i := len(attempted) - 1; i >= 0; i-- {
		if err := m.put(attempted[i], before.values[attempted[i]]); err != nil {
			failures = append(failures, err)
		}
	}
	if err := m.verify(before); err != nil {
		failures = append(failures, err)
	}
	if err := errors.Join(failures...); err != nil {
		return errors.Join(cause, fmt.Errorf("startup rollback incomplete: %w", err))
	}
	return fmt.Errorf("startup values rolled back: %w", cause)
}

func stringBytes(text string) []byte {
	words := utf16.Encode([]rune(text + "\x00"))
	data := make([]byte, len(words)*2)
	for i, word := range words {
		binary.LittleEndian.PutUint16(data[i*2:], word)
	}
	return data
}
