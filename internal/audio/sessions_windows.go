//go:build windows

package audio

import (
	"fmt"
	"math"
	"unsafe"
)

type nativeSession struct {
	control, volume *comObject
	process         *pinnedProcess // Borrowed; the discovery scope owns the handle.
}

func (s *nativeSession) close() { s.volume.release(); s.control.release() }

func (s *nativeSession) validate() error {
	if !s.process.alive() {
		return ErrStaleTarget
	}
	var pid uint32
	// Only S_OK identifies one process. Positive success codes may describe a
	// cross-process session, whose initial creator PID is unsafe to act upon.
	if s.control.invoke(14, uintptr(unsafe.Pointer(&pid))) != 0 || pid != s.process.info.id {
		return ErrStaleTarget
	}
	var state uint32
	if err := hresult("IAudioSessionControl.GetState", s.control.invoke(3, uintptr(unsafe.Pointer(&state)))); err != nil {
		return err
	}
	if state > 1 || s.control.invoke(15) != 1 {
		return ErrStaleTarget
	}
	return nil
}

func (s *nativeSession) read() (float64, bool, error) {
	var scalar float32
	var mute int32
	if err := hresult("ISimpleAudioVolume.GetMasterVolume", s.volume.invoke(4, uintptr(unsafe.Pointer(&scalar)))); err != nil {
		return 0, false, err
	}
	if err := hresult("ISimpleAudioVolume.GetMute", s.volume.invoke(6, uintptr(unsafe.Pointer(&mute)))); err != nil {
		return 0, false, err
	}
	return float64(scalar) * 100, mute != 0, nil
}

func (s *nativeSession) set(percent float64) error {
	return hresult("ISimpleAudioVolume.SetMasterVolume", s.volume.invoke(3, uintptr(math.Float32bits(float32(percent/100))), 0))
}

func (w *worker) discover(foreground uint32, processes map[uint32]process, pins map[uint32]*pinnedProcess, guard func() error) ([]*nativeSession, error) {
	var collection *comObject
	err := hresult("EnumAudioEndpoints", w.enumerator.invoke(3, 0, 1, uintptr(unsafe.Pointer(&collection))))
	collection, err = checkedObject(collection, err)
	if err != nil {
		return nil, err
	}
	defer collection.release()
	var count uint32
	if err := hresult("IMMDeviceCollection.GetCount", collection.invoke(3, uintptr(unsafe.Pointer(&count)))); err != nil {
		return nil, err
	}
	if count > 4096 {
		return nil, fmt.Errorf("invalid render endpoint count: %d", count)
	}
	var found []*nativeSession
	for i := uint32(0); i < count; i++ {
		if err := guard(); err != nil {
			return found, err
		}
		var device *comObject
		err := hresult("IMMDeviceCollection.Item", collection.invoke(4, uintptr(i), uintptr(unsafe.Pointer(&device))))
		device, err = checkedObject(device, err)
		if err != nil {
			return found, err
		}
		sessions, err := discoverDevice(device, foreground, processes, pins, guard)
		device.release()
		found = append(found, sessions...)
		if err != nil {
			return found, err
		}
	}
	return found, nil
}

func discoverDevice(device *comObject, foreground uint32, processes map[uint32]process, pins map[uint32]*pinnedProcess, guard func() error) ([]*nativeSession, error) {
	manager, err := device.activate(&iidSessionManager)
	if err != nil {
		return nil, err
	}
	defer manager.release()
	var enumerator *comObject
	err = hresult("GetSessionEnumerator", manager.invoke(5, uintptr(unsafe.Pointer(&enumerator))))
	enumerator, err = checkedObject(enumerator, err)
	if err != nil {
		return nil, err
	}
	defer enumerator.release()
	var count int32
	if err := hresult("IAudioSessionEnumerator.GetCount", enumerator.invoke(3, uintptr(unsafe.Pointer(&count)))); err != nil {
		return nil, err
	}
	if count < 0 || count > 65536 {
		return nil, fmt.Errorf("invalid audio session count: %d", count)
	}
	var found []*nativeSession
	for i := int32(0); i < count; i++ {
		if err := guard(); err != nil {
			return found, err
		}
		var control *comObject
		err := hresult("IAudioSessionEnumerator.GetSession", enumerator.invoke(4, uintptr(i), uintptr(unsafe.Pointer(&control))))
		control, err = checkedObject(control, err)
		if err != nil {
			return found, err
		}
		session, err := selectSession(control, foreground, processes, pins)
		control.release()
		if err != nil {
			return found, err
		}
		if session != nil {
			found = append(found, session)
		}
	}
	return found, nil
}

func selectSession(control *comObject, foreground uint32, processes map[uint32]process, pins map[uint32]*pinnedProcess) (*nativeSession, error) {
	control2, err := control.query(&iidSessionControl2)
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			control2.release()
		}
	}()
	var pid, state uint32
	if control2.invoke(14, uintptr(unsafe.Pointer(&pid))) != 0 || pid == 0 || !belongsTo(pid, foreground, processes) {
		return nil, nil
	}
	if err := hresult("IAudioSessionControl.GetState", control2.invoke(3, uintptr(unsafe.Pointer(&state)))); err != nil {
		return nil, err
	}
	// Inactive sessions remain useful mixer targets. Expired/system sounds do not.
	if state > 1 || control2.invoke(15) != 1 {
		return nil, nil
	}
	pin := pins[pid]
	if !pin.alive() {
		return nil, ErrStaleTarget
	}
	volume, err := control2.query(&iidSimpleVolume)
	if err != nil {
		return nil, err
	}
	keep = true
	return &nativeSession{control: control2, volume: volume, process: pin}, nil
}
