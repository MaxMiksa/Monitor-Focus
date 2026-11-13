package startup

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// All tests use this registry. None call package Snapshot/Configure/Restore or
// userRegistry, so running the suite never opens the real Windows registry.
type memoryRegistry struct {
	keys             map[string]map[string]Value
	reads, mutations int
	failRead         int
	failMutation     map[int]error
	partialFailure   bool
	ignoreMutation   int
}

var errDenied = errors.New("injected registry permission failure")
var errRollback = errors.New("injected rollback failure")

func memory() *memoryRegistry {
	return &memoryRegistry{keys: map[string]map[string]Value{RunKey: {}, ApprovedKey: {}}, failMutation: map[int]error{}}
}
func copyValue(v Value) Value { v.Data = slices.Clone(v.Data); return v }
func (r *memoryRegistry) Read(key, name string) (Value, error) {
	r.reads++
	if r.reads == r.failRead {
		return Value{}, errDenied
	}
	values, exists := r.keys[key]
	if !exists {
		return Value{}, nil
	}
	v, exists := values[name]
	if !exists {
		return Value{KeyExists: true}, nil
	}
	v.KeyExists, v.Exists = true, true
	return v, nil // deliberately aliases memory; Manager must copy snapshot bytes
}
func (r *memoryRegistry) Write(key, name string, kind uint32, data []byte) error {
	r.mutations++
	err := r.failMutation[r.mutations]
	if err != nil && !r.partialFailure {
		return err
	}
	if r.mutations != r.ignoreMutation {
		if r.keys[key] == nil {
			r.keys[key] = map[string]Value{}
		}
		r.keys[key][name] = Value{KeyExists: true, Exists: true, Type: kind, Data: slices.Clone(data)}
	}
	return err
}
func (r *memoryRegistry) Delete(key, name string) error {
	r.mutations++
	err := r.failMutation[r.mutations]
	if err != nil && !r.partialFailure {
		return err
	}
	if r.mutations != r.ignoreMutation {
		delete(r.keys[key], name)
	}
	return err
}
func (r *memoryRegistry) seed(key, name string, kind uint32, data []byte) {
	if r.keys[key] == nil {
		r.keys[key] = map[string]Value{}
	}
	r.keys[key][name] = Value{KeyExists: true, Exists: true, Type: kind, Data: slices.Clone(data)}
}
func cloneKeys(r *memoryRegistry) map[string]map[string]Value {
	result := map[string]map[string]Value{}
	for key, values := range r.keys {
		result[key] = map[string]Value{}
		for name, v := range values {
			result[key][name] = copyValue(v)
		}
	}
	return result
}
func seeded() *memoryRegistry {
	r := memory()
	r.seed(RunKey, AppName, 2, stringBytes(`"C:\old\MonitorsFocus.exe" --center --background`))
	r.seed(ApprovedKey, AppName, binaryType, []byte{3, 0, 0, 0, 9, 8, 7, 6, 5, 4, 3, 2})
	r.seed(RunKey, LegacyName, stringType, stringBytes(`"C:\old\legacy.exe"`))
	r.seed(ApprovedKey, LegacyName, binaryType, []byte{3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8})
	r.seed(RunKey, "OtherApp", stringType, stringBytes("other command"))
	r.seed(ApprovedKey, "OtherApp", binaryType, []byte{3, 0, 0, 0})
	return r
}
func executable(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "有 空格 & (lab) $literal")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "Monitors Focus.exe")
	if err := os.WriteFile(path, []byte("test fixture; never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func decodeString(t *testing.T, data []byte) string {
	t.Helper()
	if len(data)%2 != 0 || len(data) < 2 || !bytes.Equal(data[len(data)-2:], []byte{0, 0}) {
		t.Fatal("not a terminated UTF-16 string")
	}
	words := make([]uint16, len(data)/2-1)
	for i := range words {
		words[i] = binary.LittleEndian.Uint16(data[i*2:])
	}
	return string(utf16.Decode(words))
}
func expectState(t *testing.T, got, want State) {
	t.Helper()
	for i := range entries {
		if !sameValue(got.values[i], want.values[i]) {
			t.Fatalf("entry %v changed: got %+v, want %+v", entries[i], got.values[i], want.values[i])
		}
	}
}

func TestCommandValidationBeforeRegistryAccess(t *testing.T) {
	path := executable(t)
	command, err := Command(path)
	if err != nil {
		t.Fatal(err)
	}
	if command != `"`+path+`" --mode native --hardware --production --background` {
		t.Fatalf("wrong command %q", command)
	}
	for _, invalid := range []string{"", "relative.exe", `C:relative.exe`, `\root-relative.exe`, `"` + path + `"`, path + "\n", path + "\x00", filepath.Join(t.TempDir(), "missing.exe"), filepath.Dir(path), strings.TrimSuffix(path, ".exe") + ".cmd"} {
		r := seeded()
		m := NewManager(r)
		for _, enabled := range []bool{true, false} {
			if err := m.Configure(invalid, enabled); err == nil {
				t.Fatalf("accepted path %q", invalid)
			}
		}
		if r.reads != 0 || r.mutations != 0 {
			t.Fatal("invalid path touched registry")
		}
	}
}

func TestEnableSingleEntryApprovalAndExactRestore(t *testing.T) {
	path := executable(t)
	r := seeded()
	original := cloneKeys(r)
	m := NewManager(r)
	m.now = func() time.Time { return time.Unix(0, 123400) }
	before, err := m.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if r.mutations != 0 {
		t.Fatal("snapshot wrote registry")
	}
	if err := m.Configure(path, true); err != nil {
		t.Fatal(err)
	}
	run := r.keys[RunKey][AppName]
	if run.Type != stringType || decodeString(t, run.Data) != `"`+path+`" `+Arguments {
		t.Fatal("wrong Run command")
	}
	approved := r.keys[ApprovedKey][AppName]
	if approved.Type != binaryType || len(approved.Data) != 12 || approved.Data[0] != 2 || binary.LittleEndian.Uint64(approved.Data[4:]) != 116444736000001234 {
		t.Fatal("wrong enabled StartupApproved record", approved)
	}
	for _, key := range []string{RunKey, ApprovedKey} {
		if _, exists := r.keys[key][LegacyName]; exists {
			t.Fatal("historical duplicate survived")
		}
		if !reflect.DeepEqual(r.keys[key]["OtherApp"], original[key]["OtherApp"]) {
			t.Fatal("other application changed")
		}
	}
	if err := m.Restore(before); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.keys, original) {
		t.Fatal("restore did not retain exact old types/bytes")
	}
}

func TestEnabledApprovalPreservedAndConfigureIdempotent(t *testing.T) {
	path := executable(t)
	for _, data := range [][]byte{{2}, {2, 0, 0, 0, 99, 88, 77, 66, 55, 44, 33, 22, 11}} {
		r := memory()
		r.seed(ApprovedKey, AppName, binaryType, data)
		m := NewManager(r)
		if err := m.Configure(path, true); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(r.keys[ApprovedKey][AppName].Data, data) {
			t.Fatal("enabled approval bytes/timestamp changed")
		}
		mutations := r.mutations
		if err := m.Configure(path, true); err != nil {
			t.Fatal(err)
		}
		if r.mutations != mutations {
			t.Fatal("idempotent configure wrote values")
		}
	}
}

func TestAbsentApprovalKeyNotCreatedAndDisableClearsValues(t *testing.T) {
	path := executable(t)
	r := &memoryRegistry{keys: map[string]map[string]Value{}, failMutation: map[int]error{}}
	m := NewManager(r)
	before, err := m.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Configure(path, true); err != nil {
		t.Fatal(err)
	}
	if _, exists := r.keys[ApprovedKey]; exists {
		t.Fatal("created Explorer-owned approval key")
	}
	if err := m.Restore(before); err != nil {
		t.Fatal(err)
	}
	if len(r.keys[RunKey]) != 0 {
		t.Fatal("restore did not remove previously absent Run value")
	}
	r = seeded()
	m = NewManager(r)
	original := cloneKeys(r)
	before, err = m.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Configure(path, false); err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if _, exists := r.keys[e.key][e.name]; exists {
			t.Fatal("disable retained owned value", e)
		}
	}
	if err := m.Restore(before); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.keys, original) {
		t.Fatal("disable/restore lost original state")
	}
}

func TestApprovalAbsentOrWrongTypeCorrected(t *testing.T) {
	path := executable(t)
	for _, kind := range []uint32{0, stringType, binaryType, 4} {
		r := memory()
		if kind != 0 {
			r.seed(ApprovedKey, AppName, kind, []byte{3, 4, 5})
		}
		m := NewManager(r)
		before, err := m.Snapshot()
		if err != nil {
			t.Fatal(err)
		}
		if err := m.Configure(path, true); err != nil {
			t.Fatal(err)
		}
		got := r.keys[ApprovedKey][AppName]
		if got.Type != binaryType || len(got.Data) != 12 || got.Data[0] != 2 {
			t.Fatal("invalid/missing/disabled approval not corrected")
		}
		if err := m.Restore(before); err != nil {
			t.Fatal(err)
		}
		after, err := m.Snapshot()
		if err != nil {
			t.Fatal(err)
		}
		expectState(t, after, before)
	}
}

func TestSnapshotReadFailureDoesNotMutate(t *testing.T) {
	path := executable(t)
	for read := 1; read <= 4; read++ {
		r := seeded()
		original := cloneKeys(r)
		r.failRead = read
		if err := NewManager(r).Configure(path, true); !errors.Is(err, errDenied) {
			t.Fatal("snapshot read failure lost", err)
		}
		if r.mutations != 0 || !reflect.DeepEqual(r.keys, original) {
			t.Fatal("read failure changed registry")
		}
	}
}

func TestEachMutationFailureRollsBackIncludingPartialWrites(t *testing.T) {
	path := executable(t)
	for _, restore := range []bool{false, true} {
		for _, partial := range []bool{false, true} {
			for fail := 1; fail <= 4; fail++ {
				r := seeded()
				m := NewManager(r)
				snapshot, err := m.Snapshot()
				if err != nil {
					t.Fatal(err)
				}
				if restore {
					if err := m.Configure(path, true); err != nil {
						t.Fatal(err)
					}
				}
				original := cloneKeys(r)
				r.mutations = 0
				r.partialFailure = partial
				r.failMutation[fail] = errDenied
				if restore {
					err = m.Restore(snapshot)
				} else {
					err = m.Configure(path, true)
				}
				if !errors.Is(err, errDenied) || !strings.Contains(err.Error(), "rolled back") {
					t.Fatalf("restore=%v partial=%v step=%d: %v", restore, partial, fail, err)
				}
				if !reflect.DeepEqual(r.keys, original) {
					t.Fatalf("rollback lost values: restore=%v partial=%v step=%d", restore, partial, fail)
				}
			}
		}
	}
}

func TestDisableFailuresRollBack(t *testing.T) {
	path := executable(t)
	for fail := 1; fail <= 4; fail++ {
		r := seeded()
		original := cloneKeys(r)
		r.failMutation[fail] = errDenied
		r.partialFailure = true
		if err := NewManager(r).Configure(path, false); !errors.Is(err, errDenied) {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(r.keys, original) {
			t.Fatal("failed disable changed original")
		}
	}
}

func TestVerificationFailuresRollBack(t *testing.T) {
	path := executable(t)
	for _, reason := range []string{"read-error", "silent-write-failure"} {
		r := seeded()
		original := cloneKeys(r)
		if reason == "read-error" {
			r.failRead = 5
		} else {
			r.ignoreMutation = 1
		}
		if err := NewManager(r).Configure(path, true); err == nil || !strings.Contains(err.Error(), "rolled back") {
			t.Fatal("verification failure not returned", err)
		}
		if !reflect.DeepEqual(r.keys, original) {
			t.Fatal("verification failure did not roll back")
		}
	}
}

func TestRollbackFailureIsReported(t *testing.T) {
	path := executable(t)
	r := seeded()
	r.partialFailure = true
	r.failMutation[2] = errDenied
	r.failMutation[3] = errRollback
	err := NewManager(r).Configure(path, true)
	if !errors.Is(err, errDenied) || !errors.Is(err, errRollback) || !strings.Contains(err.Error(), "rollback incomplete") {
		t.Fatal("rollback failure hidden", err)
	}
}

func TestSnapshotsOwnBytesAndZeroSnapshotRejected(t *testing.T) {
	r := seeded()
	m := NewManager(r)
	if err := m.Restore(State{}); err == nil || r.reads != 0 || r.mutations != 0 {
		t.Fatal("zero snapshot accepted/touched registry")
	}
	before, err := m.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	saved := slices.Clone(before.values[1].Data)
	r.keys[ApprovedKey][AppName].Data[0] = 2
	if !bytes.Equal(before.values[1].Data, saved) {
		t.Fatal("snapshot aliases registry buffers")
	}
	if err := m.Restore(before); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(r.keys[ApprovedKey][AppName].Data, saved) {
		t.Fatal("snapshot bytes were not restored")
	}
	if _, err := NewManager(nil).Snapshot(); err == nil {
		t.Fatal("nil registry accepted")
	}
}
