package main

import (
	"encoding/json"
	"fmt"
	"myscreen/internal/win32"
	"os"
	"path/filepath"
	"slices"
	"time"
)

func runHardwareCheck() {
	failed := false
	emit := func(event string, fields map[string]any) {
		fields["event"] = event
		fields["at"] = time.Now().Format(time.RFC3339Nano)
		json.NewEncoder(os.Stdout).Encode(fields)
	}
	if win32.ExistingCore() {
		emit("refused", map[string]any{"reason": "C# core still running"})
		os.Exit(2)
	}
	native, err := newHardwareBackend(true)
	if err != nil {
		emit("startup-failed", map[string]any{"error": err.Error()})
		os.Exit(2)
	}
	baseline := map[string][]uint16{}
	for _, d := range native.worker.Displays {
		baseline[d.Id] = slices.Clone(d.Gamma)
	}
	emit("takeover-baseline", map[string]any{"CSharpCorePresent": win32.ExistingCore(), "PhysicalConsole": win32.Console(), "Displays": native.worker.Displays})
	for _, d := range native.worker.Displays {
		if d.Method == "none" || d.Error != "" {
			emit("brightness-skipped", map[string]any{"id": d.Id, "error": d.Error})
			continue
		}
		original := d.Brightness
		target := original + 2
		if target > 100 {
			target = original - 2
		}
		for cycle := 1; cycle <= 5; cycle++ {
			start := time.Now()
			err := native.worker.Set(d.Id, target)
			emit("brightness-write-readback", map[string]any{"id": d.Id, "method": d.Method, "cycle": cycle, "target": target, "actual": d.Brightness, "elapsedMs": float64(time.Since(start).Microseconds()) / 1000, "error": errorText(err)})
			if err != nil || d.Brightness != target {
				failed = true
			}
			err = native.worker.Set(d.Id, original)
			if err != nil || d.Brightness != original {
				failed = true
				emit("brightness-restore-failed", map[string]any{"id": d.Id, "error": errorText(err), "actual": d.Brightness})
				break
			}
		}
		if !d.ColorMode.SDR || d.ColorError != "" || len(d.Gamma) != 768 {
			emit("gamma-skipped", map[string]any{"id": d.Id, "error": d.ColorError})
			continue
		}
		for cycle := 1; cycle <= 5; cycle++ {
			start := time.Now()
			err := native.worker.Temperature(d.Id, 4500)
			isolated := true
			for _, other := range native.worker.Displays {
				if other.Id == d.Id {
					continue
				}
				ramp, readErr := win32.ReadGamma(other.GDI)
				if readErr != nil || !slices.Equal(ramp, baseline[other.Id]) {
					isolated = false
				}
			}
			emit("gamma-write-readback", map[string]any{"id": d.Id, "cycle": cycle, "kelvin": 4500, "elapsedMs": float64(time.Since(start).Microseconds()) / 1000, "otherDisplayUnchanged": isolated, "error": errorText(err)})
			if err != nil || !isolated {
				failed = true
			}
			restoreErr := native.worker.RestoreColors()
			ramp, readErr := win32.ReadGamma(d.GDI)
			restored := restoreErr == nil && readErr == nil && slices.Equal(ramp, baseline[d.Id])
			emit("gamma-restored", map[string]any{"id": d.Id, "cycle": cycle, "exactOriginal": restored, "error": errorText(restoreErr)})
			if !restored {
				failed = true
				break
			}
			if err != nil {
				break
			}
		}
	}
	if err = native.worker.ValidateRecovery(filepath.Join(profilePath(false), "validation-colors.json"), os.Stdout); err != nil {
		failed = true
		emit("recovery-validation-failed", map[string]any{"error": err.Error()})
	}
	err = native.closeHardware()
	if err != nil {
		failed = true
	}
	emit("cleanup", map[string]any{"error": errorText(err), "success": !failed, "CSharpCorePresent": win32.ExistingCore()})
	if failed {
		fmt.Fprintln(os.Stderr, "Native acceptance had failures; see JSONL and restoration records")
		os.Exit(1)
	}
}
func errorText(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}
