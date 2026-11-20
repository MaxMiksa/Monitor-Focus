package main

import (
	"errors"
	"myscreen/internal/audio"
	"myscreen/internal/desktop"
)

// No session is different from a real session whose mixer level is zero.
func missingApplicationAudio(err error) bool {
	return errors.Is(err, audio.ErrNoTarget) || errors.Is(err, audio.ErrNoSessions)
}
func applicationVolumeFeedback(state audio.State, err error) desktop.Feedback {
	if missingApplicationAudio(err) {
		return desktop.Feedback{Label: "应用音量", Value: "请先播放音频", HideProgress: true}
	}
	return desktop.Feedback{Label: state.Name, Percent: state.Percent, Muted: state.Muted}
}
