//go:build windows

package win32

import "testing"

func TestRescanBindingsFollowIdentity(t *testing.T) {
	bindings := displayBindings{
		`DISPLAY\A\ONE`:   {`\\.\DISPLAY2`},
		`DISPLAY\B\TWO`:   {`\\.\DISPLAY1`},
		`DISPLAY\C\CLONE`: {`\\.\DISPLAY3`, `\\.\DISPLAY4`},
	}
	for _, tc := range []struct{ id, device string }{
		{`display\a\one`, `\\.\DISPLAY2`},
		{`DISPLAY\B\TWO`, `\\.\DISPLAY1`},
	} {
		got, err := displayBinding(bindings, tc.id)
		if err != nil || got != tc.device {
			t.Fatalf("%s: got %q, %v; want %q", tc.id, got, err, tc.device)
		}
	}
	for _, id := range []string{`DISPLAY\C\CLONE`, `DISPLAY\OFFLINE`} {
		if got, err := displayBinding(bindings, id); err == nil || got != "" {
			t.Fatalf("unsafe binding accepted for %s: %q, %v", id, got, err)
		}
	}
}

func TestRescanTemporaryBindingDoesNotRetargetOldHandle(t *testing.T) {
	d := &Display{GDI: `\\.\DISPLAY1`, physical: physical{Handle: 123}}
	w := &Worker{}
	if err := w.restoreGammaAt(d, `\\.\DISPLAY2`); err != nil {
		t.Fatal(err)
	}
	if d.GDI != `\\.\DISPLAY1` || d.physical.Handle != 123 {
		t.Fatal("temporary gamma binding escaped into old hardware state")
	}
}
