package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"monitorsfocus/internal/domain"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Backend struct {
	solar  domain.SolarCache
	mu     sync.Mutex
	mode   string
	state  map[string]any
	path   string
	native *NativeBackend
}

func NewBackend(mode string, writes bool, root string) (*Backend, error) {
	b := &Backend{mode: mode, path: filepath.Join(root, "mock-settings.json")}
	if mode != "mock" && mode != "native" {
		return nil, fmt.Errorf("unsupported mode: %s", mode)
	}
	if mode == "native" {
		n, err := NewNativeBackend(writes, root)
		b.native = n
		return b, err
	}
	if err := json.Unmarshal(mockState, &b.state); err != nil {
		return nil, err
	}
	if data, err := os.ReadFile(b.path); err == nil {
		var settings map[string]any
		if json.Unmarshal(data, &settings) != nil {
			return nil, errors.New("实验配置损坏，保留原文件")
		}
		b.state["Settings"] = settings
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return b, nil
}
func (b *Backend) Request(r Request) (map[string]any, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	// Pure, bounded astronomical preview: no hardware, writes or arbitrary URL.
	if r.Action == "solar-times" {
		if r.SolarLocation == nil {
			return nil, errors.New("缺少城市")
		}
		if err := r.SolarLocation.Validate(); err != nil {
			return nil, err
		}
		return map[string]any{"SolarTimes": b.solar.Today(r.SolarLocation, time.Now())}, nil
	}
	switch r.Action {
	case "snapshot", "brightness", "temperature", "restore-color", "link", "scene", "pause", "resume-plan", "rescan", "save":
	default:
		return nil, fmt.Errorf("不支持的界面操作：%s", r.Action)
	}
	if b.mode == "native" {
		state, err := b.native.Request(r)
		if err != nil {
			return nil, err
		}
		// Reply encoding happens after this lock is released. Return an owned copy.
		data, err := json.Marshal(state)
		if err != nil {
			return nil, err
		}
		var result map[string]any
		err = json.Unmarshal(data, &result)
		return result, err
	}
	settings := b.state["Settings"].(map[string]any)
	switch r.Action {
	case "snapshot", "rescan":
	case "pause":
		b.state["FocusPaused"] = !b.state["FocusPaused"].(bool)
	case "brightness", "temperature":
		if r.Value == nil {
			return nil, errors.New("缺少数值")
		}
		min, max := 0., 100.
		if r.Action == "temperature" {
			min, max = 2700, 6500
		}
		if *r.Value < min || *r.Value > max {
			return nil, errors.New("数值超出范围")
		}
		found := false
		for _, raw := range b.state["Displays"].([]any) {
			d := raw.(map[string]any)
			if d["Id"] == r.Id {
				found = true
				if r.Action == "brightness" {
					d["Brightness"] = *r.Value
				} else {
					d["Kelvin"] = *r.Value
				}
			}
		}
		if !found {
			return nil, errors.New("设备不存在")
		}
	case "restore-color":
		for _, raw := range b.state["Displays"].([]any) {
			d := raw.(map[string]any)
			if r.Id == "" || d["Id"] == r.Id {
				d["Kelvin"] = nil
			}
		}
	case "link":
		settings["Linked"] = r.Value != nil && *r.Value == 1
		settings["Revision"] = settings["Revision"].(float64) + 1
	case "scene":
		found := false
		for _, raw := range settings["Scenes"].([]any) {
			scene := raw.(map[string]any)
			if scene["Id"] != r.Id {
				continue
			}
			found = true
			for _, display := range b.state["Displays"].([]any) {
				d := display.(map[string]any)
				if rawTarget, ok := scene["Targets"].(map[string]any)[d["Id"].(string)]; ok {
					t := rawTarget.(map[string]any)
					d["Brightness"] = t["Brightness"]
					d["Kelvin"] = t["Kelvin"]
				}
			}
		}
		if !found {
			return nil, errors.New("场景不存在")
		}
	case "save":
		if r.Settings == nil {
			return nil, errors.New("缺少配置")
		}
		if r.Settings["Revision"] != settings["Revision"] {
			return nil, errors.New("配置已变化，保留草稿并重新载入")
		}
		if r.Settings["LaunchOnStartup"] == true {
			return nil, errors.New("实验工程不修改登录自启")
		}
		copyData, _ := json.Marshal(r.Settings)
		var next map[string]any
		json.Unmarshal(copyData, &next)
		next["Revision"] = settings["Revision"].(float64) + 1
		data, _ := json.MarshalIndent(next, "", "  ")
		temp := b.path + ".tmp"
		if err := os.WriteFile(temp, data, 0600); err != nil {
			return nil, err
		}
		if err := os.Rename(temp, b.path); err != nil {
			return nil, err
		}
		b.state["Settings"] = next
	case "resume-plan":
		return nil, errors.New("模拟模式未实现自动计划执行")
	}
	// Clone under lock: the async encoder must never observe later mutation.
	data, _ := json.Marshal(b.state)
	var result map[string]any
	json.Unmarshal(data, &result)
	return result, nil
}
func (b *Backend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.native != nil {
		return b.native.Close()
	}
	return nil
}

//go:embed internal/domain/testdata/mock.json
var mockState []byte
