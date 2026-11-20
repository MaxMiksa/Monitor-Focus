package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileMigrationKeepsStateAndOriginal(t *testing.T) {
	base := t.TempDir()
	old, next := filepath.Join(base, "old"), filepath.Join(base, "new")
	files := map[string]string{
		"native-settings.json":                     "settings",
		"native-settings.json.bak":                 "backup",
		"native-colors.json":                       "colors",
		"WebView2/native/Local Storage/000001.log": "browser preferences",
		"host-native.jsonl":                        "old trace",
	}
	for name, data := range files {
		path := filepath.Join(old, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	lock := filepath.Join(old, "native-settings.json.lock")
	if err := os.WriteFile(lock, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareProfile(next, old); err == nil {
		t.Fatal("migrated locked state")
	}
	if _, err := os.Stat(next); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("published partial profile", err)
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	if err := prepareProfile(next, old); err != nil {
		t.Fatal(err)
	}
	for name, want := range files {
		data, err := os.ReadFile(filepath.Join(old, name))
		if err != nil || string(data) != want {
			t.Fatalf("original %s: %q, %v", name, data, err)
		}
		data, err = os.ReadFile(filepath.Join(next, name))
		if name == "host-native.jsonl" {
			if !errors.Is(err, os.ErrNotExist) {
				t.Fatal("old trace copied", err)
			}
		} else if err != nil || string(data) != want {
			t.Fatalf("migrated %s: %q, %v", name, data, err)
		}
	}
	if err := os.WriteFile(filepath.Join(next, "native-settings.json"), []byte("updated"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareProfile(next, old); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(next, "native-settings.json")); err != nil || string(got) != "updated" {
		t.Fatal("overwrote newer settings", string(got), err)
	}
}
