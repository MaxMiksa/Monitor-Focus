//go:build windows

package audio

import (
	"errors"
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

type result struct {
	state State
	err   error
}
type job struct {
	run   func(*worker) (State, error)
	reply chan result
}
type worker struct {
	enumerator       *comObject
	fixtures         map[*SilentSession]*silentNativeSession
	applicationCheck *applicationValidation
	systemCheck      *systemValidation
}

// Controller owns a locked MTA OS thread. Calls are serialized; Close rejects
// new work, cancels queued jobs, and waits for in-flight native calls to drain.
// There is deliberately no timeout masquerading as COM cancellation.
type Controller struct {
	mu       sync.Mutex
	closed   bool
	stopping atomic.Bool
	jobs     chan job
	done     chan struct{}
}

func New() (*Controller, error) {
	// SyscallN's floating-point ABI is verified here only for Windows amd64.
	if runtime.GOARCH != "amd64" {
		return nil, fmt.Errorf("native audio supports windows/amd64; got %s", runtime.GOARCH)
	}
	return startController(func() (*worker, func(), error) {
		hr, _, _ := coInitializeEx.Call(0, 0) // COINIT_MULTITHREADED
		if err := hresult("CoInitializeEx(MTA)", uint32(hr)); err != nil {
			return nil, nil, err
		}
		enumerator, err := newEnumerator()
		if err != nil {
			coUninitialize.Call()
			return nil, nil, err
		}
		w := &worker{enumerator: enumerator, fixtures: map[*SilentSession]*silentNativeSession{}}
		return w, func() {
			if w.systemCheck != nil {
				w.systemCheck.close()
			}
			for _, fixture := range w.fixtures {
				fixture.close()
			}
			enumerator.release()
			coUninitialize.Call()
		}, nil
	})
}

func startController(initialize func() (*worker, func(), error)) (*Controller, error) {
	c := &Controller{jobs: make(chan job, 32), done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(c.done)
		w, cleanup, err := initialize()
		if err != nil {
			ready <- err
			return
		}
		defer cleanup()
		ready <- nil
		for j := range c.jobs {
			if c.stopping.Load() {
				j.reply <- result{err: ErrClosed}
				continue
			}
			state, err := j.run(w)
			j.reply <- result{state, err}
		}
	}()
	if err := <-ready; err != nil {
		<-c.done
		return nil, err
	}
	return c, nil
}

func (c *Controller) call(run func(*worker) (State, error)) (State, error) {
	if c == nil || c.done == nil {
		return State{}, ErrClosed
	}
	j := job{run: run, reply: make(chan result, 1)}
	c.mu.Lock()
	if c.closed || c.stopping.Load() {
		c.mu.Unlock()
		return State{}, ErrClosed
	}
	c.jobs <- j
	c.mu.Unlock()
	r := <-j.reply
	return r.state, r.err
}

func (c *Controller) Close() error {
	if c == nil || c.done == nil {
		return nil
	}
	c.stopping.Store(true)
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		close(c.jobs)
	}
	c.mu.Unlock()
	<-c.done
	return nil
}

func (c *Controller) guard() error {
	if c.stopping.Load() {
		return ErrClosed
	}
	return physicalConsole()
}

func (c *Controller) SystemVolume() (State, error) { return c.systemVolume(nil) }

// SetSystemVolume sets an absolute mixer percentage and never changes mute.
func (c *Controller) SetSystemVolume(percent float64) (State, error) {
	if err := validatePercent(percent); err != nil {
		return State{}, err
	}
	return c.systemVolume(&percent)
}

func (c *Controller) systemVolume(percent *float64) (State, error) {
	return c.call(func(w *worker) (State, error) {
		if err := c.guard(); err != nil {
			return State{}, err
		}
		device, err := defaultDevice(w.enumerator)
		if err != nil {
			return State{}, err
		}
		defer device.release()
		id, err := deviceID(device)
		if err != nil {
			return State{}, err
		}
		if w.systemCheck != nil && id != w.systemCheck.deviceID {
			return State{}, ErrDeviceChanged
		}
		volume, err := device.activate(&iidEndpointVolume)
		if err != nil {
			return State{}, err
		}
		defer volume.release()
		state := State{Name: deviceName(device, id)}
		read := func() error {
			var scalar float32
			var mute int32
			if err := hresult("GetMasterVolumeLevelScalar", volume.invoke(9, uintptr(unsafe.Pointer(&scalar)))); err != nil {
				return err
			}
			if err := hresult("IAudioEndpointVolume.GetMute", volume.invoke(15, uintptr(unsafe.Pointer(&mute)))); err != nil {
				return err
			}
			state.Percent, state.Muted = float64(scalar)*100, mute != 0
			return validatePercent(state.Percent)
		}
		if err := read(); err != nil {
			return State{}, err
		}
		if percent != nil {
			if err := c.guard(); err != nil {
				return state, err
			}
			if err := w.checkDefault(id); err != nil {
				return state, err
			}
			if err := c.guard(); err != nil {
				return state, err
			}
			var context uintptr
			if check := w.systemCheck; check != nil {
				if err := read(); err != nil {
					return state, err
				}
				if err := check.before(state); err != nil {
					return state, err
				}
				context = uintptr(unsafe.Pointer(&check.observer.context))
				check.attempted = true
				check.expected.Percent = float64(float32(*percent/100)) * 100
			}
			// On amd64 SyscallN copies argument bits into the float registers.
			if err := hresult("SetMasterVolumeLevelScalar", volume.invoke(7, uintptr(math.Float32bits(float32(*percent/100))), context)); err != nil {
				return state, errors.Join(ErrPartialWrite, err)
			}
			if err := read(); err != nil {
				return state, errors.Join(ErrPartialWrite, err)
			}
			if math.Abs(state.Percent-*percent) > 0.5 {
				return state, errors.Join(ErrPartialWrite, errors.New("endpoint volume readback did not match requested percentage"))
			}
			if check := w.systemCheck; check != nil {
				if check.observer.external.Load() || state.Muted != check.expected.Muted {
					return state, errors.Join(ErrPartialWrite, errValidationExternal)
				}
				check.expected = state
			}
		}
		if err := w.checkDefault(id); err != nil {
			if percent != nil {
				err = errors.Join(ErrPartialWrite, err)
			}
			return state, err
		}
		return state, nil
	})
}

func (w *worker) checkDefault(expected string) error {
	current, err := defaultDevice(w.enumerator)
	if err != nil {
		return err
	}
	defer current.release()
	id, err := deviceID(current)
	if err != nil {
		return err
	}
	if id != expected {
		return ErrDeviceChanged
	}
	return nil
}

func (c *Controller) ApplicationVolume(hwnd uintptr) (State, error) {
	return c.applicationVolume(hwnd, nil)
}

func (c *Controller) SetApplicationVolume(hwnd uintptr, percent float64) (State, error) {
	if err := validatePercent(percent); err != nil {
		return State{}, err
	}
	return c.applicationVolume(hwnd, &percent)
}

func (c *Controller) applicationVolume(hwnd uintptr, percent *float64) (State, error) {
	if c == nil || c.stopping.Load() {
		return State{}, ErrClosed
	}
	// Capture identity before enqueueing so a reused HWND/PID cannot retarget a job.
	target, err := captureTarget(hwnd)
	if err != nil {
		return State{}, err
	}
	defer target.close()
	return c.call(func(w *worker) (State, error) {
		guard := func() error {
			if err := c.guard(); err != nil {
				return err
			}
			return target.current()
		}
		if err := guard(); err != nil {
			return State{}, err
		}
		processes, pins, err := target.resolve()
		defer func() {
			for _, p := range pins {
				p.close()
			}
		}()
		if err != nil {
			return State{}, err
		}
		sessions, err := w.discover(target.pid, processes, pins, guard)
		defer func() {
			for _, s := range sessions {
				s.close()
			}
		}()
		if err != nil {
			return State{}, err
		}
		if w.applicationCheck != nil {
			if err := w.applicationCheck.check(hwnd, sessions); err != nil {
				return State{}, err
			}
		}
		mixer := make([]mixerSession, len(sessions))
		for i, s := range sessions {
			mixer[i] = s
		}
		state, err := mix(mixer, percent, guard)
		state.ProcessID, state.Name = target.pid, imageName(target.pin.info.image)
		return state, err
	})
}
