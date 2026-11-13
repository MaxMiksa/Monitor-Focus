package domain

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsReadOnlyPermissionsPreserveConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	store := NewStore(path)
	saved, err := store.Save(DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	before := testRead(t, path)
	if err := os.Chmod(path, 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0600) })
	saved.Language = "en"
	if _, err := store.Save(saved); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("expected permission failure, got %v", err)
	}
	if !bytes.Equal(testRead(t, path), before) {
		t.Fatal("permission failure changed config")
	}
	requireEqual(t, saved.Revision, int64(1))
	requireCleanStore(t, path)
}
