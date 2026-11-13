package main

import (
	"encoding/json"
	"testing"
)

func TestBridgeOriginBoundary(t *testing.T) {
	for _, url := range []string{"http://wails.localhost.evil/", "http://wails.localhost:99/", "https://wails.localhost/", "http://user@wails.localhost/", "file:///C:/index.html"} {
		if trustedURL(url, "http://wails.localhost") {
			t.Fatalf("accepted untrusted URL %s", url)
		}
	}
	if !trustedURL("http://wails.localhost/?language=zh-CN", "http://wails.localhost") {
		t.Fatal("valid full page URL rejected")
	}
}
func TestMockPersistenceConflictAndSnapshotIsolation(t *testing.T) {
	root := t.TempDir()
	b, err := NewBackend("mock", false, root)
	if err != nil {
		t.Fatal(err)
	}
	old, err := b.Request(Request{Action: "snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	settings := old["Settings"].(map[string]any)
	settings["Language"] = "en"
	saved, err := b.Request(Request{Action: "save", Settings: settings})
	if err != nil {
		t.Fatal(err)
	}
	if old["Settings"].(map[string]any)["Revision"] != float64(0) {
		t.Fatal("previous snapshot mutated")
	}
	if _, err = b.Request(Request{Action: "save", Settings: settings}); err == nil {
		t.Fatal("stale draft accepted")
	}
	savedSettings := saved["Settings"].(map[string]any)
	savedSettings["LaunchOnStartup"] = true
	if _, err = b.Request(Request{Action: "save", Settings: savedSettings}); err == nil {
		t.Fatal("startup write allowed")
	}
	reopened, err := NewBackend("mock", false, root)
	if err != nil {
		t.Fatal(err)
	}
	state, _ := reopened.Request(Request{Action: "snapshot"})
	if state["Settings"].(map[string]any)["Language"] != "en" {
		t.Fatal("settings not persisted")
	}
	before, _ := json.Marshal(b.state)
	if _, err = b.Request(Request{Action: "exit"}); err == nil {
		t.Fatal("non-allowlisted action accepted")
	}
	after, _ := json.Marshal(b.state)
	if string(before) != string(after) {
		t.Fatal("rejected request mutated state")
	}
}
