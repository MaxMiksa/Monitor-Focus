package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
)

var (
	ErrConflict       = errors.New("settings revision conflict")
	ErrCorrupt        = errors.New("invalid existing settings; original preserved")
	ErrBusy           = errors.New("settings store is locked by another writer")
	ErrBackupMismatch = errors.New("existing migration backup differs from legacy input")
)

type ConflictError struct {
	Expected int64
	Actual   int64
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("%v: draft %d, current %d", ErrConflict, e.Expected, e.Actual)
}
func (e *ConflictError) Unwrap() error { return ErrConflict }

// Store never discovers a profile or touches startup. Supply an isolated path.
// All writers must cooperate with its lock; Load never creates files/directories.
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(path string) *Store { return &Store{path: path} }
func (s *Store) Path() string     { return s.path }

func (s *Store) Load() (Settings, error) {
	settings, _, _, err := s.readCurrent()
	return settings, err
}

// Save compares draft.Revision with the disk revision under an exclusive lock.
// It returns a new draft only on success and never increments/mutates the caller.
// Bad/unreadable existing files are never replaced with defaults.
func (s *Store) Save(draft Settings) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return Settings{}, fmt.Errorf("empty settings path")
	}
	if err := Validate(draft); err != nil {
		return Settings{}, err
	}
	unlock, err := s.lock()
	if err != nil {
		return Settings{}, err
	}
	defer unlock()
	current, raw, exists, err := s.readCurrent()
	if err != nil {
		return Settings{}, err
	}
	if draft.Revision != current.Revision {
		return Settings{}, &ConflictError{Expected: draft.Revision, Actual: current.Revision}
	}
	if current.Revision == math.MaxInt64 {
		return Settings{}, fmt.Errorf("revision exhausted")
	}
	next := WithSceneDefaults(draft)
	next.Revision = current.Revision + 1
	if err := s.write(next, raw, exists); err != nil {
		return Settings{}, err
	}
	return next, nil
}

func (s *Store) readCurrent() (Settings, []byte, bool, error) {
	if s.path == "" {
		return Settings{}, nil, false, fmt.Errorf("empty settings path")
	}
	raw, err := readRegular(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return DefaultSettings(), nil, false, nil
	}
	if err != nil {
		return Settings{}, nil, false, err
	}
	settings, err := DecodeSettings(raw)
	if err != nil {
		return Settings{}, nil, true, fmt.Errorf("%w: %w", ErrCorrupt, err)
	}
	return settings, raw, true, nil
}

func readRegular(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("refusing non-regular configuration file %q", path)
	}
	return os.ReadFile(path)
}

// A persistent .lock means a crashed writer needs operator review. Never guess
// that another process is dead and risk concurrent writers. Readers need no lock.
func (s *Store) lock() (func(), error) {
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return nil, err
	}
	path := s.path + ".lock"
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil, ErrBusy
	}
	if err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	return func() { _ = os.Remove(path) }, nil
}

func (s *Store) write(settings Settings, previous []byte, exists bool) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := syncedTemp(s.path, data)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	// Backup contains exact pre-save bytes, including absent legacy scene fields.
	return replaceSettings(temporary, s.path, previous, exists)
}

func syncedTemp(target string, data []byte) (string, error) {
	f, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+"-*.tmp")
	if err != nil {
		return "", err
	}
	name := f.Name()
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}

// DecodeLegacy migrates only real v1 product fields (language, delay, startup).
// It does not import old overlay/hardware dimming as current product targets.
func DecodeLegacy(data []byte) (Settings, error) {
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return Settings{}, fmt.Errorf("legacy settings must be an object")
	}
	legacy := struct {
		DelaySeconds    int
		LaunchOnStartup bool
		Language        json.RawMessage
	}{DelaySeconds: 180}
	if err := rejectNullValues(data, reflect.TypeOf(legacy)); err != nil {
		return Settings{}, err
	}
	if err := json.Unmarshal(data, &legacy); err != nil {
		return Settings{}, err
	}
	s := DefaultSettings()
	s.FocusDelaySeconds = clamp(legacy.DelaySeconds, 0, 600)
	s.LaunchOnStartup = legacy.LaunchOnStartup
	if len(legacy.Language) != 0 {
		var name string
		if err := json.Unmarshal(legacy.Language, &name); err == nil {
			switch strings.ToLower(name) {
			case "english", "0":
				s.Language = "en"
			case "chinese", "1":
				s.Language = "zh-CN"
			case "system", "2":
			default:
				return Settings{}, fmt.Errorf("unsupported legacy language %q", name)
			}
		} else {
			var number int
			if err := json.Unmarshal(legacy.Language, &number); err != nil {
				return Settings{}, fmt.Errorf("invalid legacy language")
			}
			switch number {
			case 0:
				s.Language = "en"
			case 1:
				s.Language = "zh-CN"
			default:
				s.Language = "system"
			}
		}
	}
	return s, Validate(s)
}

// MigrateLegacy is explicitly writeful. It refuses an existing destination,
// decodes before touching disk, backs up the original legacy bytes before the
// atomic first save, and leaves the source intact. Load never calls this method.
func (s *Store) MigrateLegacy(legacyPath string) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" || legacyPath == "" {
		return Settings{}, fmt.Errorf("migration needs explicit paths")
	}
	if _, err := os.Lstat(s.path); err == nil {
		return Settings{}, ErrConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return Settings{}, err
	}
	raw, err := readRegular(legacyPath)
	if err != nil {
		return Settings{}, err
	}
	next, err := DecodeLegacy(raw)
	if err != nil {
		return Settings{}, fmt.Errorf("%w: %w", ErrCorrupt, err)
	}
	unlock, err := s.lock()
	if err != nil {
		return Settings{}, err
	}
	defer unlock()
	if _, err := os.Lstat(s.path); err == nil {
		return Settings{}, ErrConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return Settings{}, err
	}
	if err := ensureMigrationBackup(legacyPath+".pre-center.bak", raw); err != nil {
		return Settings{}, err
	}
	next.Revision = 1
	if err := s.write(next, nil, false); err != nil {
		return Settings{}, err
	}
	return next, nil
}

func ensureMigrationBackup(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		existing, err := readRegular(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(existing, data) {
			return ErrBackupMismatch
		}
		return nil
	}
	if err != nil {
		return err
	}
	_, err = io.Copy(f, bytes.NewReader(data))
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		_ = os.Remove(path)
	}
	return err
}
