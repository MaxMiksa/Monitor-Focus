//go:build windows

package audio

import (
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errValidationExternal = errors.New("validation detected a newer external volume/mute change; preserve external state")

// Only the explicit validation entry registers this observer. Native reference
// counting plus a root and Pinner keep it alive until COM releases its last ref.
// Callbacks do no COM, audio, logging or waiting.
type endpointObserver struct {
	vtable   *[4]uintptr
	refs     atomic.Int32
	external atomic.Bool
	context  windows.GUID
	pin      runtime.Pinner
}

var observerRoots sync.Map
var observerVTable [4]uintptr
var observerVTableOnce sync.Once
var iidEndpointCallback = guid("{657804FA-D6AD-4496-8A60-352752AF4F89}")
var iidUnknown = guid("{00000000-0000-0000-C000-000000000046}")

func newEndpointObserver(context windows.GUID) *endpointObserver {
	observerVTableOnce.Do(func() {
		observerVTable = [4]uintptr{
			windows.NewCallback(observerQuery), windows.NewCallback(observerAddRef),
			windows.NewCallback(observerRelease), windows.NewCallback(observerNotify),
		}
	})
	o := &endpointObserver{vtable: &observerVTable, context: context}
	o.refs.Store(1)
	o.pin.Pin(o)
	observerRoots.Store(o, o)
	return o
}

func observerQuery(o *endpointObserver, iid *windows.GUID, out **endpointObserver) uintptr {
	if out == nil {
		return 0x80004003
	} // E_POINTER
	*out = nil
	if iid == nil {
		return 0x80004003
	}
	if *iid != iidUnknown && *iid != iidEndpointCallback {
		return 0x80004002
	}
	observerAddRef(o)
	*out = o
	return 0
}
func observerAddRef(o *endpointObserver) uintptr { return uintptr(o.refs.Add(1)) }
func observerRelease(o *endpointObserver) uintptr {
	refs := o.refs.Add(-1)
	if refs == 0 {
		observerRoots.Delete(o)
		o.pin.Unpin()
	}
	return uintptr(refs)
}
func observerNotify(o *endpointObserver, context *windows.GUID) uintptr {
	// GUID is the first member of AUDIO_VOLUME_NOTIFICATION_DATA. We need no
	// other fields; even a same-volume external change invalidates restoration.
	if context == nil || *context != o.context {
		o.external.Store(true)
	}
	return 0
}

type systemValidation struct {
	deviceID  string
	expected  State
	observer  *endpointObserver
	volume    *comObject
	attempted bool
}

func (s *systemValidation) before(actual State) error {
	if s.observer.external.Load() || !sameVolume(actual, s.expected) {
		return errValidationExternal
	}
	return nil
}

func (c *Controller) beginSystemValidation() (*systemValidation, error) {
	var check *systemValidation
	_, err := c.call(func(w *worker) (State, error) {
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
		volume, err := device.activate(&iidEndpointVolume)
		if err != nil {
			return State{}, err
		}
		var context windows.GUID
		hr, _, _ := ole32.NewProc("CoCreateGuid").Call(uintptr(unsafe.Pointer(&context)))
		if err := hresult("CoCreateGuid(validation)", uint32(hr)); err != nil {
			volume.release()
			return State{}, err
		}
		observer := newEndpointObserver(context)
		if err := hresult("RegisterControlChangeNotify(validation)", volume.invoke(3, uintptr(unsafe.Pointer(observer)))); err != nil {
			observerRelease(observer)
			volume.release()
			return State{}, err
		}
		check = &systemValidation{deviceID: id, observer: observer, volume: volume}
		w.systemCheck = check
		return State{}, nil
	})
	return check, err
}

func (c *Controller) endSystemValidation(check *systemValidation) error {
	_, err := c.call(func(w *worker) (State, error) {
		w.systemCheck = nil
		return State{}, check.close()
	})
	return err
}

func (check *systemValidation) close() error {
	if check.volume == nil {
		return nil
	}
	err := hresult("UnregisterControlChangeNotify(validation)", check.volume.invoke(4, uintptr(unsafe.Pointer(check.observer))))
	// On unregister failure COM still owns its ref; keep the pinned object
	// rooted until COM releases it, rather than freeing a live callback.
	observerRelease(check.observer)
	check.volume.release()
	check.volume = nil
	return err
}
