//go:build windows

package win32

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"time"
)

// ValidateRecovery runs only in the explicit, exclusive hardware-check command.
// It simulates lost volatile ownership; it does not terminate any process.
func (w *Worker) ValidateRecovery(path string, output io.Writer) (result error) {
	emit := func(name string, fields map[string]any) {
		fields["event"] = name
		fields["at"] = time.Now().Format(time.RFC3339Nano)
		json.NewEncoder(output).Encode(fields)
	}
	if err := w.ConfigureRecovery(path); err != nil {
		return err
	}
	for _, d := range w.Displays {
		original, err := ReadGamma(d.GDI)
		if err != nil {
			return err
		}
		warm, err := warmRamp(original, 4500)
		if err != nil {
			return err
		}
		external, err := warmRamp(original, 5000)
		if err != nil {
			return err
		}
		err = func() (failure error) {
			defer func() {
				// Restore only tables written by this check, never a newer external table.
				cleanup := w.Call(func() error {
					current, e := ReadGamma(d.GDI)
					if e != nil {
						return e
					}
					if !slices.Equal(current, original) && !slices.Equal(current, warm) && !slices.Equal(current, external) {
						return errors.New("new external gamma detected during validation; preserved")
					}
					if e = d.colorSafe(); e != nil {
						return e
					}
					if e = writeGamma(d.GDI, original); e != nil {
						return e
					}
					d.color = nil
					return w.persistColors()
				})
				failure = errors.Join(failure, cleanup)
			}()
			if e := w.Temperature(d.Id, 4500); e != nil {
				return e
			}
			journal := recoveryJournal{Version: 1, Displays: []recoveryDisplay{{ID: d.Id, GDI: d.GDI, Original: original, Last: warm}}}
			data, _ := json.Marshal(journal)
			if e := os.WriteFile(path, data, 0600); e != nil {
				return e
			}
			if e := w.Call(func() error { d.color = nil; return nil }); e != nil {
				return e
			}
			if e := w.ConfigureRecovery(path); e != nil {
				return e
			}
			actual, e := ReadGamma(d.GDI)
			if e != nil || !slices.Equal(actual, original) {
				return fmt.Errorf("stale journal restore mismatch: %v", e)
			}
			emit("stale-journal-recovered", map[string]any{"id": d.Id, "exactOriginal": true, "simulated": true})
			if e = w.Temperature(d.Id, 4500); e != nil {
				return e
			}
			if e = w.Call(func() error {
				if e := d.colorSafe(); e != nil {
					return e
				}
				return writeGamma(d.GDI, external)
			}); e != nil {
				return e
			}
			rejected := w.Temperature(d.Id, 4400)
			if rejected == nil {
				return errors.New("external gamma was not rejected")
			}
			restoreNotice := w.RestoreColors()
			actual, e = ReadGamma(d.GDI)
			if e != nil || !slices.Equal(actual, external) {
				return errors.New("newer external gamma was overwritten")
			}
			emit("external-gamma-preserved", map[string]any{"id": d.Id, "writeRejected": true, "restorePreserved": true, "restoreReportedConflict": restoreNotice != nil, "simulated": true})
			// A stale recovery journal must preserve a newer external table as well.
			if e = os.WriteFile(path, data, 0600); e != nil {
				return e
			}
			if e = w.ConfigureRecovery(path); e != nil {
				return e
			}
			actual, e = ReadGamma(d.GDI)
			if e != nil || !slices.Equal(actual, external) {
				return errors.New("recovery overwrote newer external gamma")
			}
			emit("stale-journal-external-preserved", map[string]any{"id": d.Id, "exactExternal": true, "simulated": true})
			return nil
		}()
		if err != nil {
			return err
		}
	}
	return nil
}
