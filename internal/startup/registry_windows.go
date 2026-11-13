package startup

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// These functions are dormant until explicitly called by the adopting host.
// Never Configure after a failed config read/migration or a fallback to defaults.
var currentUser = NewManager(userRegistry{})

func Snapshot() (State, error) { return currentUser.Snapshot() }
func Configure(executablePath string, enabled bool) error {
	return currentUser.Configure(executablePath, enabled)
}
func Restore(snapshot State) error { return currentUser.Restore(snapshot) }

type userRegistry struct{}

func (userRegistry) Read(path, name string) (Value, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return Value{}, nil
	}
	if err != nil {
		return Value{}, err
	}
	defer key.Close()
	data := make([]byte, 256)
	for attempt := 0; attempt < 4; attempt++ {
		n, kind, err := key.GetValue(name, data)
		if errors.Is(err, registry.ErrNotExist) {
			return Value{KeyExists: true}, nil
		}
		if errors.Is(err, registry.ErrShortBuffer) {
			if n <= len(data) || n > 1<<20 {
				return Value{}, errors.New("startup registry value has invalid size")
			}
			data = make([]byte, n)
			continue
		}
		if err != nil {
			return Value{}, err
		}
		return Value{KeyExists: true, Exists: true, Type: kind, Data: data[:n]}, nil
	}
	return Value{}, errors.New("startup registry value changed repeatedly while reading")
}

var setRawValue = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegSetValueExW")

func (userRegistry) Write(path, name string, kind uint32, data []byte) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	valueName, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var buffer *byte
	if len(data) > 0 {
		buffer = &data[0]
	}
	code, _, _ := setRawValue.Call(uintptr(key), uintptr(unsafe.Pointer(valueName)), 0, uintptr(kind), uintptr(unsafe.Pointer(buffer)), uintptr(len(data)))
	runtime.KeepAlive(data)
	if code != 0 {
		return fmt.Errorf("RegSetValueExW: %w", syscall.Errno(code))
	}
	return nil
}

func (userRegistry) Delete(path, name string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer key.Close()
	err = key.DeleteValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	return err
}
