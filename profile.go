package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func profilePath(production bool) string {
	return localProfile("MyScreen", production)
}

func legacyProfilePath(production bool) string {
	return localProfile("Monitors-Focus-Go", production)
}

func localProfile(name string, production bool) string {
	if !production {
		name += "-Dev"
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), name)
}

func profileExists(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, fmt.Errorf("profile is not a directory: %s", path)
	}
	return true, nil
}

// Stage only user state, not old traces. Publish the complete profile at once
// and leave the legacy data intact as a backup if the user needs to roll back.
func prepareProfile(target, legacy string) error {
	if exists, err := profileExists(target); exists || err != nil {
		return err
	}
	old, err := profileExists(legacy)
	if err != nil {
		return err
	}
	if !old {
		return os.MkdirAll(target, 0700)
	}
	for _, name := range []string{"native-settings.json.lock", "native-colors.json.lock"} {
		if _, err := os.Lstat(filepath.Join(legacy, name)); !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("cannot migrate locked or unreadable profile: %s", name)
		}
	}
	stage, err := os.MkdirTemp(filepath.Dir(target), ".MyScreen-migration-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	for _, name := range []string{"native-settings.json", "native-settings.json.bak", "native-colors.json", "native-colors.json.bak", "mock-settings.json", "WebView2"} {
		info, err := os.Lstat(filepath.Join(legacy, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if (name == "WebView2" && !info.IsDir()) || (name != "WebView2" && !info.Mode().IsRegular()) {
			return fmt.Errorf("cannot migrate unexpected profile entry: %s", name)
		}
		dest := filepath.Join(stage, name)
		if info.IsDir() {
			if err := os.CopyFS(dest, os.DirFS(filepath.Join(legacy, name))); err != nil {
				return fmt.Errorf("copy browser profile: %w", err)
			}
			continue
		}
		data, err := os.ReadFile(filepath.Join(legacy, name))
		if err != nil {
			return err
		}
		if err := os.WriteFile(dest, data, 0600); err != nil {
			return err
		}
	}
	if err := os.Rename(stage, target); err != nil {
		// A second mode can finish migrating the shared dev profile first.
		if exists, _ := profileExists(target); !exists {
			return fmt.Errorf("publish migrated profile: %w", err)
		}
	}
	return nil
}
