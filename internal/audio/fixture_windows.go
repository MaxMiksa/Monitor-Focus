//go:build windows

package audio

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SilentSession is an opt-in, nonpersistent WASAPI session in THIS process.
// Its stream is initialized but never started: it produces no sound. Merely
// constructing a Controller does not create a session. All operations still run
// on the controller's COM thread; no other app or endpoint volume is modified.
type SilentSession struct{ controller *Controller }

type silentNativeSession struct {
	client  *comObject
	session *nativeSession
	pin     *pinnedProcess
}

func (s *silentNativeSession) close() { s.session.close(); s.client.release(); s.pin.close() }

// NewSilentSession creates a uniquely identified session for later, explicitly
// invoked integration acceptance. It is not used by ordinary tests.
func (c *Controller) NewSilentSession() (*SilentSession, error) {
	var fixture *SilentSession
	_, err := c.call(func(w *worker) (State, error) {
		if err := c.guard(); err != nil {
			return State{}, err
		}
		device, err := defaultDevice(w.enumerator)
		if err != nil {
			return State{}, err
		}
		defer device.release()
		iidClient := guid("{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}")
		client, err := device.activate(&iidClient)
		if err != nil {
			return State{}, err
		}
		keep := false
		defer func() {
			if !keep {
				client.release()
			}
		}()
		var format unsafe.Pointer
		if err := hresult("IAudioClient.GetMixFormat", client.invoke(8, uintptr(unsafe.Pointer(&format)))); err != nil {
			return State{}, err
		}
		defer coTaskMemFree.Call(uintptr(format))
		var id windows.GUID
		hr, _, _ := ole32.NewProc("CoCreateGuid").Call(uintptr(unsafe.Pointer(&id)))
		if err := hresult("CoCreateGuid", uint32(hr)); err != nil {
			return State{}, err
		}
		// Shared, NOPERSIST, 100ms buffer; no Start, no render buffer, no SetMute.
		if err := hresult("IAudioClient.Initialize(silent fixture)", client.invoke(3, 0, 0x00080000, 1000000, 0, uintptr(format), uintptr(unsafe.Pointer(&id)))); err != nil {
			return State{}, err
		}
		var base *comObject
		iidControl := guid("{F4B1A599-7266-4319-A8CA-E70ACB11E8CD}")
		err = hresult("IAudioClient.GetService(IAudioSessionControl)", client.invoke(14, uintptr(unsafe.Pointer(&iidControl)), uintptr(unsafe.Pointer(&base))))
		base, err = checkedObject(base, err)
		if err != nil {
			return State{}, err
		}
		defer base.release()
		control, err := base.query(&iidSessionControl2)
		if err != nil {
			return State{}, err
		}
		defer func() {
			if !keep {
				control.release()
			}
		}()
		var volume *comObject
		err = hresult("IAudioClient.GetService(ISimpleAudioVolume)", client.invoke(14, uintptr(unsafe.Pointer(&iidSimpleVolume)), uintptr(unsafe.Pointer(&volume))))
		volume, err = checkedObject(volume, err)
		if err != nil {
			return State{}, err
		}
		defer func() {
			if !keep {
				volume.release()
			}
		}()
		pin, err := pinProcess(windows.GetCurrentProcessId(), 0)
		if err != nil {
			return State{}, err
		}
		defer func() {
			if !keep {
				pin.close()
			}
		}()
		session := &nativeSession{control: control, volume: volume, process: pin}
		if err := session.validate(); err != nil {
			return State{}, err
		}
		fixture = &SilentSession{controller: c}
		w.fixtures[fixture] = &silentNativeSession{client: client, session: session, pin: pin}
		keep = true
		return State{}, nil
	})
	return fixture, err
}

func (s *SilentSession) State() (State, error) { return s.volume(nil) }

// SetVolume changes only this test session, preserving mute. Running it is an
// audio write and must be explicitly authorized by the integration-test owner.
func (s *SilentSession) SetVolume(percent float64) (State, error) {
	if err := validatePercent(percent); err != nil {
		return State{}, err
	}
	return s.volume(&percent)
}

func (s *SilentSession) volume(percent *float64) (State, error) {
	if s == nil || s.controller == nil {
		return State{}, ErrClosed
	}
	return s.controller.call(func(w *worker) (State, error) {
		fixture, ok := w.fixtures[s]
		if !ok {
			return State{}, ErrClosed
		}
		state, err := mix([]mixerSession{fixture.session}, percent, s.controller.guard)
		state.Name, state.ProcessID = "MyScreen native audio test", windows.GetCurrentProcessId()
		return state, err
	})
}

// Close releases the unstarted stream; Controller.Close also owns this cleanup.
func (s *SilentSession) Close() error {
	if s == nil || s.controller == nil {
		return nil
	}
	_, err := s.controller.call(func(w *worker) (State, error) {
		if fixture, ok := w.fixtures[s]; ok {
			fixture.close()
			delete(w.fixtures, s)
		}
		return State{}, nil
	})
	if errors.Is(err, ErrClosed) {
		return s.controller.Close()
	}
	return err
}
