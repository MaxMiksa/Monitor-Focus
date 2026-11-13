//go:build windows

package win32

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type luid struct {
	Low  uint32
	High int32
}
type configHeader struct {
	Type, Size uint32
	Adapter    luid
	Id         uint32
}
type sourceName struct {
	Header configHeader
	Name   [32]uint16
}
type targetName struct {
	Header                  configHeader
	Flags, OutputTechnology uint32
	Manufacturer, Product   uint16
	Connector               uint32
	Friendly                [64]uint16
	Path                    [128]uint16
}
type colorInfo struct {
	Header                          configHeader
	Flags, Encoding, BitsPerChannel uint32
}
type ColorMode struct {
	SDR            bool
	Internal       bool
	Friendly       string
	TargetIdentity string
}

func ReadColorMode(device string) (ColorMode, error) {
	for attempt := 0; attempt < 3; attempt++ {
		var pc, mc uint32
		status, _, _ := user32.NewProc("GetDisplayConfigBufferSizes").Call(2, uintptr(unsafe.Pointer(&pc)), uintptr(unsafe.Pointer(&mc)))
		if status != 0 {
			return ColorMode{}, fmt.Errorf("CCD sizes: %d", status)
		}
		if pc == 0 || pc > 128 || mc == 0 || mc > 512 {
			return ColorMode{}, errors.New("invalid CCD buffer counts")
		}
		paths := make([][72]byte, pc)
		modes := make([][64]byte, mc)
		status, _, _ = user32.NewProc("QueryDisplayConfig").Call(2, uintptr(unsafe.Pointer(&pc)), uintptr(unsafe.Pointer(&paths[0])), uintptr(unsafe.Pointer(&mc)), uintptr(unsafe.Pointer(&modes[0])), 0)
		if status == 122 {
			continue
		}
		if status != 0 {
			return ColorMode{}, fmt.Errorf("CCD query: %d", status)
		}
		count := 0
		var result ColorMode
		for _, path := range paths[:pc] {
			source := sourceName{Header: configHeader{Type: 1, Size: uint32(unsafe.Sizeof(sourceName{})), Adapter: luid{binary.LittleEndian.Uint32(path[0:4]), int32(binary.LittleEndian.Uint32(path[4:8]))}, Id: binary.LittleEndian.Uint32(path[8:12])}}
			status, _, _ = user32.NewProc("DisplayConfigGetDeviceInfo").Call(uintptr(unsafe.Pointer(&source)))
			if status != 0 {
				return ColorMode{}, fmt.Errorf("CCD source: %d", status)
			}
			if !strings.EqualFold(windows.UTF16ToString(source.Name[:]), device) {
				continue
			}
			count++
			if count > 1 {
				return ColorMode{}, errors.New("cloned/ambiguous display source")
			}
			header := configHeader{Type: 9, Size: uint32(unsafe.Sizeof(colorInfo{})), Adapter: luid{binary.LittleEndian.Uint32(path[20:24]), int32(binary.LittleEndian.Uint32(path[24:28]))}, Id: binary.LittleEndian.Uint32(path[28:32])}
			color := colorInfo{Header: header}
			status, _, _ = user32.NewProc("DisplayConfigGetDeviceInfo").Call(uintptr(unsafe.Pointer(&color)))
			if status != 0 {
				return ColorMode{}, fmt.Errorf("CCD color: %d", status)
			}
			target := targetName{Header: header}
			target.Header.Type = 2
			target.Header.Size = uint32(unsafe.Sizeof(target))
			status, _, _ = user32.NewProc("DisplayConfigGetDeviceInfo").Call(uintptr(unsafe.Pointer(&target)))
			if status != 0 {
				return ColorMode{}, fmt.Errorf("CCD target: %d", status)
			}
			parts := strings.Split(windows.UTF16ToString(target.Path[:]), "#")
			if len(parts) != 4 {
				return ColorMode{}, errors.New("invalid CCD target identity")
			}
			tech := binary.LittleEndian.Uint32(path[36:40])
			result = ColorMode{SDR: color.Flags&2 == 0, Internal: tech == 6 || tech == 11 || tech == 13 || tech == 0x80000000, Friendly: windows.UTF16ToString(target.Friendly[:]), TargetIdentity: `DISPLAY\` + parts[1] + `\` + parts[2]}
		}
		if count != 1 {
			return ColorMode{}, errors.New("CCD mapping not found")
		}
		return result, nil
	}
	return ColorMode{}, errors.New("CCD mapping changed repeatedly")
}

type GammaOwner struct {
	Original, Last []uint16
	Kelvin         int
	Conflict       bool
}

func warmRamp(original []uint16, kelvin int) ([]uint16, error) {
	if len(original) != 768 || kelvin < 2700 || kelvin > 6500 {
		return nil, errors.New("invalid gamma target")
	}
	gains := func(k float64) [3]float64 {
		t := k / 100
		red := 255.
		green := 99.4708025861*math.Log(t) - 161.1195681661
		blue := 138.5177312231*math.Log(t-10) - 305.0447927307
		if t >= 66 {
			red = 329.698727446 * math.Pow(t-60, -0.1332047592)
			green = 288.1221695283 * math.Pow(t-60, -0.0755148492)
		}
		if t >= 66 {
			blue = 255
		}
		if t <= 19 {
			blue = 0
		}
		return [3]float64{math.Min(255, math.Max(0, red)), math.Min(255, math.Max(0, green)), math.Min(255, math.Max(0, blue))}
	}
	target, neutral := gains(float64(kelvin)), gains(6500)
	scale := 1.
	desired := make([]float64, 768)
	for c := 0; c < 3; c++ {
		ratio := math.Min(1, target[c]/neutral[c])
		for i := 0; i < 256; i++ {
			index := c*256 + i
			desired[index] = float64(original[index]) * ratio
			linear := float64(i * 257)
			delta := desired[index] - float64(original[index])
			if delta < 0 && desired[index] < linear-32768 {
				allowed := float64(original[index]) - (linear - 32768)
				scale = math.Min(scale, math.Max(0, allowed/(-delta)))
			}
		}
	}
	ramp := make([]uint16, 768)
	for i := range ramp {
		ramp[i] = uint16(math.Round(float64(original[i]) + (desired[i]-float64(original[i]))*scale))
	}
	return ramp, nil
}
func writeGamma(device string, ramp []uint16) error {
	if len(ramp) != 768 {
		return errors.New("invalid gamma table length")
	}
	p, _ := windows.UTF16PtrFromString(device)
	driver, _ := windows.UTF16PtrFromString("DISPLAY")
	dc, _, _ := gdi.NewProc("CreateDCW").Call(uintptr(unsafe.Pointer(driver)), uintptr(unsafe.Pointer(p)), 0, 0)
	if dc == 0 {
		return errors.New("CreateDC failed")
	}
	defer gdi.NewProc("DeleteDC").Call(dc)
	ok, _, _ := gdi.NewProc("SetDeviceGammaRamp").Call(dc, uintptr(unsafe.Pointer(&ramp[0])))
	if ok == 0 {
		return errors.New("Gamma write rejected")
	}
	return nil
}
func (d *Display) colorSafe() error {
	if err := d.ensure(); err != nil {
		return err
	}
	mode, err := ReadColorMode(d.GDI)
	if err != nil {
		return err
	}
	if !mode.SDR || !strings.EqualFold(mode.TargetIdentity, d.Id) {
		return errors.New("HDR or uncertain CCD target; refused gamma write")
	}
	return nil
}
func (w *Worker) Temperature(id string, kelvin int) error {
	return w.callNamed("temperature", map[string]any{"deviceId": id, "target": kelvin}, func() error {
		for _, d := range w.Displays {
			if d.Id != id {
				continue
			}
			if err := d.colorSafe(); err != nil {
				return err
			}
			if kelvin == 6500 {
				return w.restoreGamma(d)
			}
			current, err := ReadGamma(d.GDI)
			if err != nil {
				return err
			}
			owner := d.color
			if owner == nil {
				owner = &GammaOwner{Original: slices.Clone(current)}
				d.color = owner
			} else if owner.Conflict || !slices.Equal(current, owner.Last) && !slices.Equal(current, owner.Original) {
				owner.Conflict = true
				return errors.New("external gamma changed; stopped ownership")
			}
			ramp, err := warmRamp(owner.Original, kelvin)
			if err != nil {
				return err
			}
			if slices.Equal(current, ramp) {
				owner.Last = ramp
				owner.Kelvin = kelvin
				return nil
			}
			previous := owner.Last
			owner.Last = ramp
			if err := w.persistColors(); err != nil {
				owner.Last = previous
				return fmt.Errorf("color recovery journal failed; write refused: %w", err)
			}
			writeErr := writeGamma(d.GDI, ramp)
			read, readErr := ReadGamma(d.GDI)
			if writeErr != nil || readErr != nil || !slices.Equal(read, ramp) {
				// Roll back only a table we can still identify as ours.
				if readErr == nil && (slices.Equal(read, ramp) || (len(previous) == 768 && slices.Equal(read, previous))) {
					owner.Last = slices.Clone(read)
					if restoreErr := w.restoreGamma(d); restoreErr != nil {
						return errors.Join(writeErr, readErr, restoreErr)
					}
				} else if readErr == nil && slices.Equal(read, owner.Original) {
					d.color = nil
				} else {
					owner.Conflict = true
				}
				return errors.New("gamma write/readback failed; unknown external colors preserved")
			}
			owner.Last = ramp
			owner.Kelvin = kelvin
			return nil
		}
		return errors.New("display not identified")
	})
}
func (w *Worker) restoreGamma(d *Display) error {
	owner := d.color
	if owner == nil {
		return nil
	}
	if err := d.colorSafe(); err != nil {
		return err
	}
	current, err := ReadGamma(d.GDI)
	if err != nil {
		return err
	}
	if slices.Equal(current, owner.Original) {
		d.color = nil
		return w.persistColors()
	}
	if !slices.Equal(current, owner.Last) {
		d.color = nil
		return errors.Join(errors.New("external gamma preserved; skipped restore"), w.persistColors())
	}
	if err = writeGamma(d.GDI, owner.Original); err != nil {
		return err
	}
	read, err := ReadGamma(d.GDI)
	if err != nil {
		return err
	}
	if !slices.Equal(read, owner.Original) {
		return errors.New("gamma restore readback failed")
	}
	d.color = nil
	return w.persistColors()
}
func (w *Worker) RestoreColors() error {
	return w.callNamed("restore-color", map[string]any{}, func() error {
		var errs []error
		for _, d := range w.Displays {
			if err := w.restoreGamma(d); err != nil {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	})
}
func (d *Display) Kelvin() any {
	if d.color != nil && d.color.Kelvin != 0 && !d.color.Conflict {
		return d.color.Kelvin
	}
	return nil
}

func (d *Display) ColorConflict() bool { return d.color != nil && d.color.Conflict }
