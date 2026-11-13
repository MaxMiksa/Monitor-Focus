package domain

import (
	"fmt"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var replaceFileW = kernel32.NewProc("ReplaceFileW")
var moveFileExW = kernel32.NewProc("MoveFileExW")

// ReplaceFile preserves destination security attributes and atomically creates
// the previous-version backup. Avoid delete-then-rename (a data-loss window).
func replaceSettings(temporary, target string, _ []byte, exists bool) error {
	from, err := syscall.UTF16PtrFromString(temporary)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	var result uintptr
	var callErr error
	if exists {
		backup, err := syscall.UTF16PtrFromString(target + ".bak")
		if err != nil {
			return err
		}
		result, _, callErr = replaceFileW.Call(uintptr(unsafe.Pointer(to)), uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(backup)), 0, 0, 0)
	} else {
		// No REPLACE_EXISTING: a noncooperating creator must not be overwritten.
		result, _, callErr = moveFileExW.Call(uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(to)), 8)
	}
	if result == 0 {
		return fmt.Errorf("atomic settings replacement: %w", callErr)
	}
	return nil
}
