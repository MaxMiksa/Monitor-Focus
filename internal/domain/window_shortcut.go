package domain

import "errors"

// Modifiers use the Win32 mask Alt=1, Ctrl=2, Shift=4, Win=8.
// Key is a Windows virtual-key code.
type WindowShortcut struct {
	Enabled   bool
	Modifiers uint8
	Key       uint8
}

func (s WindowShortcut) validate() error {
	validKey := s.Key >= 'A' && s.Key <= 'Z' ||
		s.Key >= '0' && s.Key <= '9' ||
		s.Key >= 0x70 && s.Key <= 0x7b // F1–F12
	if s.Modifiers == 0 || s.Modifiers > 15 || s.Modifiers == 4 || !validKey {
		return errors.New("invalid window shortcut")
	}
	return nil
}
