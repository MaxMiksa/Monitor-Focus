package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func testWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}
func testRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func requireAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected absent %s: %v", path, err)
	}
}
func requireCleanStore(t *testing.T, path string) {
	t.Helper()
	requireAbsent(t, path+".lock")
	files, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".*.tmp"))
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary files remain: %v, %v", files, err)
	}
}

func TestStoreLoadHasNoWriteOnRead(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "missing-dir", "control-center.json")
	store := NewStore(path)
	s, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, s.Revision, int64(0))
	requireAbsent(t, filepath.Dir(path))
	path = filepath.Join(root, "control-center.json")
	store = NewStore(path)
	raw := []byte(`{"FocusEnabled":true,"ControlledDisplayIds":[],"Scenes":[{"Id":"old","Name":"Saved","Targets":{"offline":{"Brightness":17,"Kelvin":null}}}]}`)
	testWrite(t, path, raw)
	s, err = store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if s.Scenes[0].Behavior == nil || !s.Scenes[0].Behavior.FocusEnabled || s.Scenes[0].Behavior.ControlledDisplayIds == nil {
		t.Fatal("missing behavior not inherited")
	}
	if !bytes.Equal(testRead(t, path), raw) {
		t.Fatal("load rewrote config")
	}
	requireAbsent(t, path+".bak")
	requireAbsent(t, path+".lock")
	saved, err := store.Save(s)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, saved.Revision, int64(1))
	requireEqual(t, s.Revision, int64(0))
	if !bytes.Equal(testRead(t, path+".bak"), raw) {
		t.Fatal("backup did not preserve original bytes")
	}
	if saved.Scenes[0].Behavior.ControlledDisplayIds == nil {
		t.Fatal("empty focus list lost on save")
	}
	requireCleanStore(t, path)
}

func TestStoreRevisionBackupAndIndependentDraft(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	store := NewStore(path)
	draft := DefaultSettings()
	saved, err := store.Save(draft)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, saved.Revision, int64(1))
	requireEqual(t, draft.Revision, int64(0))
	requireAbsent(t, path+".bak")
	firstBytes := testRead(t, path)
	stale := saved.Clone()
	saved.Language = "en"
	next, err := NewStore(path).Save(saved)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, next.Revision, int64(2))
	if !bytes.Equal(testRead(t, path+".bak"), firstBytes) {
		t.Fatal("missing previous revision backup")
	}
	latest := testRead(t, path)
	if _, err := store.Save(stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	} else {
		var conflict *ConflictError
		if !errors.As(err, &conflict) || conflict.Actual != 2 || conflict.Expected != 1 {
			t.Fatal("conflict detail unavailable")
		}
	}
	if !bytes.Equal(testRead(t, path), latest) {
		t.Fatal("stale draft overwrote newer settings")
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, next) {
		t.Fatal("disk differs from saved result")
	}
	requireCleanStore(t, path)
}

func TestStoreCorruptOrUnreadableNeverOverwrites(t *testing.T) {
	for _, raw := range []string{``, `null`, `{bad`, `{}`, `{"SchemaVersion":2}`, `{"SchemaVersion":null}`, `{"FocusEnabled":null}`, `{"focusenabled":null}`, `{"Scenes":null}`, `{"Scenes":[null]}`, `{"FocusDelaySeconds":601}`, `{"LinkWeights":null}`, `{"TemperatureBrightnessCalibrations":{"panel":null}}`, `{"Scenes":[{"Id":"a","Name":"x","Targets":{"a":null}}]}`, `{"Scenes":[{"Id":"a","Name":"x","Targets":{"a":{"Brightness":null}}}]}`} {
		if raw == `{}` {
			continue
		} // a partial old object is valid and uses product defaults
		t.Run(raw, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "settings.json")
			testWrite(t, path, []byte(raw))
			store := NewStore(path)
			if _, err := store.Load(); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("expected corruption, got %v", err)
			}
			if _, err := store.Save(DefaultSettings()); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("save must refuse original: %v", err)
			}
			if string(testRead(t, path)) != raw {
				t.Fatal("original overwritten")
			}
			requireAbsent(t, path+".bak")
			requireCleanStore(t, path)
		})
	}
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	store := NewStore(path)
	if _, err := store.Load(); err == nil {
		t.Fatal("non-file read treated as absence")
	}
	if _, err := store.Save(DefaultSettings()); err == nil {
		t.Fatal("non-file overwritten")
	}
	requireCleanStore(t, path)
	blockedParent := filepath.Join(t.TempDir(), "file")
	testWrite(t, blockedParent, []byte("unchanged"))
	if _, err := NewStore(filepath.Join(blockedParent, "settings.json")).Save(DefaultSettings()); err == nil {
		t.Fatal("write into inaccessible parent succeeded")
	}
	requireEqual(t, string(testRead(t, blockedParent)), "unchanged")
}

func TestStoreAtomicReplaceFailurePreservesDraftAndConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	store := NewStore(path)
	original, err := store.Save(DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	data := testRead(t, path)
	// A directory is an unwritable backup destination on Windows and Unix. This
	// exercises real replacement failure without changing any user permissions.
	if err := os.Mkdir(path+".bak", 0700); err != nil {
		t.Fatal(err)
	}
	original.Language = "en"
	if _, err := store.Save(original); err == nil {
		t.Fatal("replacement with blocked backup unexpectedly succeeded")
	}
	if !bytes.Equal(testRead(t, path), data) {
		t.Fatal("failed save damaged current config")
	}
	requireEqual(t, original.Revision, int64(1))
	requireCleanStore(t, path)
}

func TestStoreConcurrentWritersAndLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	store := NewStore(path)
	saved, err := store.Save(DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	const writers = 8
	errs := make(chan error, writers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range writers {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; _, err := NewStore(path).Save(saved); errs <- err }()
	}
	close(start)
	wg.Wait()
	close(errs)
	winners := 0
	for err := range errs {
		if err == nil {
			winners++
		} else if !errors.Is(err, ErrBusy) && !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	requireEqual(t, winners, 1)
	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, loaded.Revision, int64(2))
	testWrite(t, path+".lock", []byte("another writer"))
	if _, err := store.Save(loaded); !errors.Is(err, ErrBusy) {
		t.Fatal("lock ignored", err)
	}
	if _, err := store.Load(); err != nil {
		t.Fatal("read should work while writer holds lock", err)
	}
	if err := os.Remove(path + ".lock"); err != nil {
		t.Fatal(err)
	}
	requireCleanStore(t, path)
}

func TestExplicitLegacyMigrationAndBackup(t *testing.T) {
	for _, language := range []struct{ raw, want string }{{`"Chinese"`, "zh-CN"}, {`"English"`, "en"}, {`"System"`, "system"}, {`1`, "zh-CN"}, {`0`, "en"}, {`2`, "system"}} {
		t.Run(language.raw, func(t *testing.T) {
			root := t.TempDir()
			legacy := filepath.Join(root, "settings.json")
			path := filepath.Join(root, "control-center.json")
			store := NewStore(path)
			raw := []byte(`{"Language":` + language.raw + `,"DelaySeconds":999,"LaunchOnStartup":true,"ControlledMonitorIds":["old-device"],"HardwareDimLevel":10}`)
			testWrite(t, legacy, raw)
			if _, err := store.Load(); err != nil {
				t.Fatal(err)
			}
			requireAbsent(t, path)
			requireAbsent(t, legacy+".pre-center.bak")
			saved, err := store.MigrateLegacy(legacy)
			if err != nil {
				t.Fatal(err)
			}
			requireEqual(t, saved.Revision, int64(1))
			requireEqual(t, saved.Language, language.want)
			requireEqual(t, saved.FocusDelaySeconds, 600)
			requireEqual(t, saved.LaunchOnStartup, true)
			if saved.ControlledDisplayIds != nil || len(saved.Scenes) != 0 || saved.BrightnessLinkCalibration != nil || len(saved.TemperatureBrightnessCalibrations) != 0 {
				t.Fatal("legacy migration invented current targets")
			}
			if !bytes.Equal(testRead(t, legacy), raw) || !bytes.Equal(testRead(t, legacy+".pre-center.bak"), raw) {
				t.Fatal("legacy original/backup changed")
			}
			if _, err := store.MigrateLegacy(legacy); !errors.Is(err, ErrConflict) {
				t.Fatal("migration replaced existing destination", err)
			}
			requireCleanStore(t, path)
		})
	}
	s, err := DecodeLegacy([]byte(`{"DelaySeconds":-1}`))
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, s.FocusDelaySeconds, 0)
	requireEqual(t, s.Language, "system")
}

func TestMigrationFailureNeverCreatesCurrentConfig(t *testing.T) {
	for _, reason := range []string{"corrupt", "blocked-backup", "mismatched-backup", "directory-source"} {
		t.Run(reason, func(t *testing.T) {
			root := t.TempDir()
			legacy := filepath.Join(root, "settings.json")
			path := filepath.Join(root, "control-center.json")
			raw := []byte(`{"Language":"Chinese"}`)
			testWrite(t, legacy, raw)
			switch reason {
			case "corrupt":
				testWrite(t, legacy, []byte(`null`))
			case "blocked-backup":
				if err := os.Mkdir(legacy+".pre-center.bak", 0700); err != nil {
					t.Fatal(err)
				}
			case "mismatched-backup":
				testWrite(t, legacy+".pre-center.bak", []byte("original older backup"))
			case "directory-source":
				legacy = root
			}
			if _, err := NewStore(path).MigrateLegacy(legacy); err == nil {
				t.Fatal("unsafe migration succeeded")
			}
			requireAbsent(t, path)
			requireCleanStore(t, path)
		})
	}
}

func TestSavedRevisionOverflowAndValidationDoNotWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	store := NewStore(path)
	s := DefaultSettings()
	s.Revision = 1<<63 - 1
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	testWrite(t, path, raw)
	if _, err := store.Save(s); err == nil {
		t.Fatal("revision wrapped")
	}
	if !bytes.Equal(testRead(t, path), raw) {
		t.Fatal("overflow wrote config")
	}
	s.Revision = 0
	s.FocusDelaySeconds = 601
	if _, err := store.Save(s); err == nil {
		t.Fatal("invalid draft accepted")
	}
	requireCleanStore(t, path)
}
