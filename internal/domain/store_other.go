//go:build !windows

package domain

import "os"

func replaceSettings(temporary, target string, previous []byte, exists bool) error {
	if exists {
		backup, err := syncedTemp(target+".bak", previous)
		if err != nil {
			return err
		}
		defer os.Remove(backup)
		if err := os.Rename(backup, target+".bak"); err != nil {
			return err
		}
		return os.Rename(temporary, target)
	}
	// Link is atomic and refuses an existing destination on local Unix filesystems.
	return os.Link(temporary, target)
}
