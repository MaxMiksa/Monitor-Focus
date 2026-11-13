//go:build windows

package win32

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"golang.org/x/sys/windows"
)

type recoveryDisplay struct {
	ID, GDI        string
	Original, Last []uint16
}
type recoveryJournal struct {
	Version  int
	PID      uint32
	Created  uint64
	Displays []recoveryDisplay
}

func processCreated(pid uint32) (uint64, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime), nil
}

// Invoke only after exclusive ownership. Unknown/newer external colors are never
// overwritten. A journal is retained on any recovery failure for a later retry.
func (w *Worker) ConfigureRecovery(path string) error {
	return w.callNamed("recover-colors", map[string]any{}, func() error {
		if w.ownership == 0 {
			return errors.New("color recovery requires hardware ownership")
		}
		w.JournalPath = path
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		var journal recoveryJournal
		if err = json.Unmarshal(data, &journal); err != nil {
			return fmt.Errorf("color journal is invalid; preserved: %w", err)
		}
		if journal.Version != 1 || len(journal.Displays) > 16 {
			return errors.New("unsupported color journal; preserved")
		}
		if journal.PID != 0 {
			created, aliveErr := processCreated(journal.PID)
			if aliveErr == nil && created == journal.Created {
				return errors.New("color journal belongs to a running owner")
			}
			if aliveErr != nil && !errors.Is(aliveErr, windows.ERROR_INVALID_PARAMETER) {
				return fmt.Errorf("cannot verify prior color owner: %w", aliveErr)
			}
		}
		var failures []error
		for _, entry := range journal.Displays {
			if len(entry.Original) != 768 || len(entry.Last) != 768 {
				failures = append(failures, errors.New("invalid color journal table"))
				continue
			}
			var matched *Display
			for _, d := range w.Displays {
				if strings.EqualFold(d.Id, entry.ID) {
					matched = d
					break
				}
			}
			if matched == nil {
				failures = append(failures, fmt.Errorf("recovery display offline: %s", entry.ID))
				continue
			}
			if err := matched.colorSafe(); err != nil {
				failures = append(failures, err)
				continue
			}
			current, err := ReadGamma(matched.GDI)
			if err != nil {
				failures = append(failures, err)
				continue
			}
			if slices.Equal(current, entry.Original) {
				continue
			}
			if !slices.Equal(current, entry.Last) {
				if w.Trace != nil {
					w.Trace("recovery-external-colors-preserved", map[string]any{"deviceId": matched.Id})
				}
				continue
			}
			if err = writeGamma(matched.GDI, entry.Original); err != nil {
				failures = append(failures, err)
				continue
			}
			actual, err := ReadGamma(matched.GDI)
			if err != nil || !slices.Equal(actual, entry.Original) {
				failures = append(failures, errors.New("recovered gamma readback mismatch"))
				continue
			}
			matched.Gamma = slices.Clone(entry.Original)
		}
		if len(failures) > 0 {
			return errors.Join(failures...)
		}
		return w.persistColors()
	})
}

// Called on the hardware thread before each write, and after a verified restore.
func (w *Worker) persistColors() error {
	if w.JournalPath == "" {
		return nil
	}
	created, err := processCreated(windows.GetCurrentProcessId())
	if err != nil {
		return err
	}
	journal := recoveryJournal{Version: 1, PID: windows.GetCurrentProcessId(), Created: created, Displays: []recoveryDisplay{}}
	for _, d := range w.Displays {
		if d.color != nil {
			journal.Displays = append(journal.Displays, recoveryDisplay{d.Id, d.GDI, slices.Clone(d.color.Original), slices.Clone(d.color.Last)})
		}
	}
	if len(journal.Displays) == 0 {
		if err := os.Remove(w.JournalPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(w.JournalPath), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(w.JournalPath+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	from, _ := windows.UTF16PtrFromString(w.JournalPath + ".tmp")
	to, _ := windows.UTF16PtrFromString(w.JournalPath)
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
