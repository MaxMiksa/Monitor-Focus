package main

import (
	"time"

	"monitorsfocus/internal/desktop"
	"monitorsfocus/internal/domain"
)

// Called under the backend lock. A failed desktop read must not reuse cursor
// coordinates or a partially elapsed focus delay. Keep this warning separate
// from hardware/audio warnings so recovery clears only the desktop read issue.
func (n *NativeBackend) acceptFocusCapture(state desktop.DesktopState, err error, now time.Time) bool {
	previous := n.focusCaptureErr
	n.focusCaptureErr = ""
	if err != nil {
		n.focusCaptureErr = err.Error()
		n.lastDesktop = desktop.DesktopState{}
		n.lastDesktopAt = time.Time{}
		n.focus = map[string]domain.FocusState{}
	} else {
		n.lastDesktop = state
		n.lastDesktopAt = now
	}
	if previous != n.focusCaptureErr && n.trace != nil {
		n.trace("focus-capture-status", map[string]any{"available": err == nil, "error": n.focusCaptureErr})
	}
	return err == nil
}

func (n *NativeBackend) currentWarning() string {
	if n.warning != "" {
		return n.warning
	}
	if n.focusCaptureErr != "" {
		return "暂时无法读取桌面状态，专注遮罩已暂停，恢复后自动继续。"
	}
	return ""
}
