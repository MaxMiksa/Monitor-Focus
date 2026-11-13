//go:build windows

package audio

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32              = windows.NewLazySystemDLL("ole32.dll")
	coInitializeEx     = ole32.NewProc("CoInitializeEx")
	coUninitialize     = ole32.NewProc("CoUninitialize")
	coCreateInstance   = ole32.NewProc("CoCreateInstance")
	coTaskMemFree      = ole32.NewProc("CoTaskMemFree")
	propVariantClear   = ole32.NewProc("PropVariantClear")
	clsidEnumerator    = guid("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
	iidEnumerator      = guid("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
	iidEndpointVolume  = guid("{5CDF2C82-841E-4546-9722-0CF74078229A}")
	iidSessionManager  = guid("{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}")
	iidSessionControl2 = guid("{BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}")
	iidSimpleVolume    = guid("{87CE5498-68D6-44E5-9215-6DA47EF883D8}")
)

func guid(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

type comObject struct{ vtable *[32]uintptr }

// uintptr arguments containing Go pointers must escape and remain live through
// the native call; SyscallN also mirrors float bits into XMM registers on amd64.
//
//go:uintptrescapes
func (o *comObject) invoke(slot int, args ...uintptr) uint32 {
	argv := make([]uintptr, len(args)+1)
	argv[0] = uintptr(unsafe.Pointer(o))
	copy(argv[1:], args)
	hr, _, _ := syscall.SyscallN(o.vtable[slot], argv...)
	runtime.KeepAlive(o)
	return uint32(hr)
}

func hresult(operation string, hr uint32) error {
	if int32(hr) < 0 {
		return fmt.Errorf("%s: HRESULT 0x%08X", operation, hr)
	}
	return nil
}

func (o *comObject) release() {
	if o != nil {
		o.invoke(2)
	}
}

func (o *comObject) query(iid *windows.GUID) (*comObject, error) {
	var out *comObject
	err := hresult("QueryInterface", o.invoke(0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out))))
	return checkedObject(out, err)
}

func checkedObject(out *comObject, err error) (*comObject, error) {
	if err != nil {
		out.release()
		return nil, err
	}
	if out == nil {
		return nil, fmt.Errorf("CoreAudio returned a nil interface")
	}
	return out, nil
}

func newEnumerator() (*comObject, error) {
	var out *comObject
	hr, _, _ := coCreateInstance.Call(uintptr(unsafe.Pointer(&clsidEnumerator)), 0, 23,
		uintptr(unsafe.Pointer(&iidEnumerator)), uintptr(unsafe.Pointer(&out)))
	return checkedObject(out, hresult("CoCreateInstance(MMDeviceEnumerator)", uint32(hr)))
}

func (o *comObject) activate(iid *windows.GUID) (*comObject, error) {
	var out *comObject
	err := hresult("IMMDevice.Activate", o.invoke(3, uintptr(unsafe.Pointer(iid)), 23, 0, uintptr(unsafe.Pointer(&out))))
	return checkedObject(out, err)
}

func defaultDevice(enumerator *comObject) (*comObject, error) {
	var device *comObject
	err := hresult("GetDefaultAudioEndpoint(render/multimedia)", enumerator.invoke(4, 0, 1, uintptr(unsafe.Pointer(&device))))
	return checkedObject(device, err)
}

func deviceID(device *comObject) (string, error) {
	var id *uint16
	err := hresult("IMMDevice.GetId", device.invoke(5, uintptr(unsafe.Pointer(&id))))
	if id != nil {
		defer coTaskMemFree.Call(uintptr(unsafe.Pointer(id)))
	}
	if err != nil {
		return "", err
	}
	if id == nil {
		return "", fmt.Errorf("audio endpoint has no identity")
	}
	return windows.UTF16PtrToString(id), nil
}

type propertyKey struct {
	Format windows.GUID
	ID     uint32
}
type propVariant struct {
	Type     uint16
	Reserved [3]uint16
	String   *uint16 // VT_LPWSTR arm of PROPVARIANT's native union.
	Extra    uintptr
}

func deviceName(device *comObject, fallback string) string {
	var store *comObject
	err := hresult("OpenPropertyStore", device.invoke(4, 0, uintptr(unsafe.Pointer(&store))))
	if err != nil || store == nil {
		store.release()
		return fallback
	}
	defer store.release()
	key := propertyKey{guid("{A45C254E-DF1C-4EFD-8020-67D146A850E0}"), 14}
	var value propVariant
	defer propVariantClear.Call(uintptr(unsafe.Pointer(&value)))
	if hresult("GetValue(FriendlyName)", store.invoke(5, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&value)))) == nil && value.Type == 31 && value.String != nil {
		return windows.UTF16PtrToString(value.String)
	}
	return fallback
}
