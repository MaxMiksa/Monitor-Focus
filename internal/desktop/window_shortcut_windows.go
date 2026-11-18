//go:build windows

package desktop

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var keyboardCallback = windows.NewCallback(keyboardProc)

// Adjacent bits track the left/right keys for Alt, Ctrl, Shift and Win.
var modifierKeys = [...]uint32{0xa4, 0xa5, 0xa2, 0xa3, 0xa0, 0xa1, 0x5b, 0x5c}

type windowShortcut struct {
	hook      uintptr
	key       uint8
	modifiers uint8
	held      uint8
	keyDown   bool
	pressed   uint8
	pending   uint
	toggle    func()
}

func (c *Controller) ConfigureWindowShortcut(key, modifiers uint8, toggle func()) error {
	return c.call(func() error {
		s := &c.keyboard
		if key == 0 {
			return s.remove()
		}
		if s.hook == 0 {
			for _, proc := range []*windows.LazyProc{asyncKey, nextHook, consoleSession, getSystemMetrics} {
				if err := proc.Find(); err != nil {
					return err
				}
			}
			module, _, _ := getModule.Call(0)
			hook, _, err := setHook.Call(13, keyboardCallback, module, 0) // WH_KEYBOARD_LL
			if hook == 0 {
				return winError("SetWindowsHookExW", err)
			}
			s.hook = hook
			for i, vk := range modifierKeys {
				if down(uintptr(vk)) {
					s.pressed |= 1 << i
				}
			}
		}
		if s.key != key {
			s.keyDown = false
		}
		s.key, s.modifiers, s.toggle, s.pending = key, modifiers, toggle, 0
		return nil
	})
}

func (s *windowShortcut) remove() error {
	s.key, s.pending = 0, 0
	if s.hook != 0 {
		if err := boolCall(unhook, s.hook); err != nil {
			return err
		}
	}
	*s = windowShortcut{}
	return nil
}

func (s *windowShortcut) deliver() {
	n := s.pending
	s.pending = 0
	for range n {
		s.toggle()
	}
}

type keyboardInput struct {
	Key, Scan, Flags, Time uint32
	Extra                  uintptr
}

func keyboardProc(code int32, msg uintptr, data *keyboardInput) uintptr {
	if code == 0 {
		if owner, ok := threadOwners.Load(windows.GetCurrentThreadId()); ok {
			c := owner.(*Controller)
			if !c.closing.Load() && c.handleShortcut(*data) {
				return 1
			}
		}
	}
	result, _, _ := nextHook.Call(0, uintptr(code), msg, uintptr(unsafe.Pointer(data)))
	return result
}

func (c *Controller) handleShortcut(input keyboardInput) bool {
	s := &c.keyboard
	key := uint8(input.Key)
	released := input.Flags&0x80 != 0
	for i, vk := range modifierKeys {
		if input.Key == vk {
			if released {
				s.pressed &^= 1 << i
			} else {
				s.pressed |= 1 << i
			}
			return false
		}
	}
	if s.held != 0 && key == s.held {
		if released {
			s.held = 0
			if key == s.key {
				s.keyDown = false
			}
		}
		return true
	}
	if key != s.key || s.key == 0 {
		return false
	}
	wasDown := s.keyDown
	s.keyDown = !released
	if s.held != 0 || released || wasDown || s.activeModifiers() != s.modifiers || !isConsole() {
		return false
	}
	s.held = key
	s.pending++
	// Run the host callback after the keyboard hook returns.
	windows.SetEvent(c.wake)
	return true
}

func (s *windowShortcut) activeModifiers() uint8 {
	var mask uint8
	for i := range 4 {
		if s.pressed&(3<<(2*i)) != 0 {
			mask |= 1 << i
		}
	}
	return mask
}
