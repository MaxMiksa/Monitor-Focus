package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"monitorsfocus/internal/audio"
	"monitorsfocus/internal/desktop"
	"monitorsfocus/internal/startup"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"monitorsfocus/internal/win32"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed frontend/public/app.ico
var icon []byte

//go:embed frontend/public/app-white.ico
var whiteIcon []byte

// Set only by the adopted product build. Validation builds remain explicit mock.
var adoptedBuild string

type Request struct {
	Action   string
	Id       string
	Value    *float64
	Settings map[string]any
	TraceID  string `json:"-"`
}
type Message struct {
	Id      string
	Request Request
}
type Reply struct {
	Id       string
	Snapshot any    `json:",omitempty"`
	Error    string `json:",omitempty"`
}
type Host struct {
	app        *application.App
	window     *application.WebviewWindow
	backend    *Backend
	mode       string
	dev        bool
	inspect    bool
	production bool
	mu         sync.Mutex
	opened     time.Time
	serial     int
	logfile    *os.File
	dispatch   *dispatcher
}

func main() {
	win32.EnableDPI()
	defaultMode := "mock"
	productBuild := adoptedBuild == "true"
	if productBuild {
		defaultMode = "native"
	}
	mode := flag.String("mode", defaultMode, "mock | native")
	background := flag.Bool("background", false, "Start tray without creating WebView")
	panelOnly := flag.Bool("panel-only", false, "Mock UI host: exit when panel closes")
	command := flag.String("command", "open", "Second-instance command: open | close | quit")
	dev := flag.Bool("dev", false, "Use explicit development server at 127.0.0.1:5183")
	writes := flag.Bool("hardware", productBuild, "Enable native brightness writes after safe exclusive takeover")
	production := flag.Bool("production", productBuild, "Use the adopted Go profile and product exit/startup behavior; requires native hardware mode")
	probe := flag.Bool("probe", false, "Read-only Go hardware probe, no Wails window")
	check := flag.Bool("hardware-check", false, "Exclusive native hardware acceptance; refuses running C# core")
	audioCheck := flag.Bool("audio-check", false, "Explicit silent test-owned audio session acceptance; no system/app volume writes")
	desktopCheck := flag.Bool("desktop-check", false, "Explicit native hook, feedback, mask and shell OSD validation")
	audioValidation := flag.Bool("audio-validation", false, "Explicit own multi-session and reversible system audio validation")
	inspect := flag.Int("inspect-port", 0, "Explicit local WebView2 debugging port for UI acceptance only")
	call := flag.String("call", "", "Send one allowlisted JSON request to the local authenticated IPC")
	flag.Parse()
	if *production && (*mode != "native" || !*writes || *dev || *panelOnly) {
		log.Fatal("--production requires --mode native --hardware, without dev/panel-only")
	}
	if *desktopCheck || *audioValidation {
		var validationErr error
		if *desktopCheck {
			validationErr = desktop.ValidationCheck(os.Stdout)
		} else {
			validationErr = audio.ValidationCheck(os.Stdout)
		}
		if validationErr != nil {
			fmt.Fprintln(os.Stderr, validationErr)
			os.Exit(1)
		}
		return
	}
	if *audioCheck {
		runAudioCheck()
		return
	}
	if *call != "" {
		if err := nativeCall(*mode, *call); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *probe {
		runProbe()
		return
	}
	if *check {
		runHardwareCheck()
		return
	}
	if *mode != "mock" && *mode != "native" {
		log.Fatal("Unknown mode")
	}
	if *panelOnly && (*background || *mode == "native") {
		log.Fatal("--panel-only requires mock without --background")
	}
	if *command != "open" && *command != "close" && *command != "quit" {
		log.Fatal("Unknown host command")
	}
	root := filepath.Join(os.Getenv("LOCALAPPDATA"), "Monitors-Focus-Go-Dev")
	if *production {
		root = filepath.Join(os.Getenv("LOCALAPPDATA"), "Monitors-Focus-Go")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		log.Fatal(err)
	}
	file, err := os.OpenFile(filepath.Join(root, "host-"+*mode+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		log.Fatal(err)
	}
	defer file.Close()
	var backend *Backend
	var ipc *ipcServer
	host := &Host{mode: *mode, dev: *dev, logfile: file, inspect: *inspect != 0, production: *production}
	appName := "Monitors Focus Dev"
	if *production {
		appName = "Monitors Focus"
	}
	browserArgs := []string{}
	if *inspect != 0 {
		if *inspect < 1024 || *inspect > 65535 {
			log.Fatal("Invalid inspect port")
		}
		browserArgs = []string{fmt.Sprintf("--remote-debugging-port=%d", *inspect), "--remote-debugging-address=127.0.0.1"}
	}
	content, _ := fs.Sub(assets, "frontend/dist")
	bundled := application.BundledAssetFileServer(content)
	var handler http.Handler = bundled
	if *dev {
		target, _ := url.Parse("http://127.0.0.1:5183")
		proxy := httputil.NewSingleHostReverseProxy(target)
		handler = http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/wails/") {
				bundled.ServeHTTP(rw, r)
			} else {
				proxy.ServeHTTP(rw, r)
			}
		})
	}
	host.app = application.New(application.Options{
		Name: appName, Description: "Windows display controller",
		Assets:  application.AssetOptions{Handler: handler, DisableLogging: true},
		Windows: application.WindowsOptions{WndClass: trayWindowClass, DisableQuitOnLastWindowClosed: !*panelOnly, WebviewUserDataPath: filepath.Join(root, "WebView2", *mode), AdditionalBrowserArgs: browserArgs, WndProcInterceptor: fixedRatioInterceptor},
		SingleInstance: &application.SingleInstanceOptions{UniqueID: "MonitorsFocus.Go." + *mode, OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
			action := "open"
			for i, arg := range data.Args {
				if arg == "--command" && i+1 < len(data.Args) {
					action = data.Args[i+1]
				}
				if strings.HasPrefix(arg, "--command=") {
					action = strings.TrimPrefix(arg, "--command=")
				}
			}
			host.control(action)
		}},
		RawMessageHandler: host.receive,
		OnShutdown: func() {
			if ipc != nil {
				ipc.close()
			}
			if host.dispatch != nil {
				host.dispatch.close()
			}
			if backend != nil {
				if err := backend.Close(); err != nil {
					host.record("cleanup-error", map[string]any{"error": err.Error()})
				}
			}
			host.record("shutdown", nil)
		},
	})
	host.app.SetIcon(icon)
	if !*panelOnly {
		tray := host.app.SystemTray.New().SetIcon(nativeTrayIcon())
		menu := host.app.NewMenu()
		openLabel, closeLabel, exitLabel := "打开实验面板 · "+*mode, "关闭实验面板", "退出实验（保留现用程序）"
		if *production {
			openLabel, closeLabel, exitLabel = "打开 Monitors Focus", "关闭面板", "退出 Monitors Focus"
		}
		menu.Add(openLabel).OnClick(func(*application.Context) { host.open() })
		menu.Add(closeLabel).OnClick(func(*application.Context) { host.control("close") })
		menu.Add("暂停 / 恢复专注").OnClick(func(*application.Context) {
			if host.dispatch != nil {
				host.dispatch.enqueue(Request{Action: "pause"}, fmt.Sprintf("tray-%d", time.Now().UnixNano()), func(reply Reply) {
					if reply.Error != "" {
						host.record("tray-error", map[string]any{"error": reply.Error})
					}
				})
			}
		})
		menu.AddSeparator()
		menu.Add(exitLabel).OnClick(func(*application.Context) { host.app.Quit() })
		tray.SetMenu(menu)
		tray.OnClick(host.open)
	}
	host.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		// Single-instance forwarding is resolved before any backend or hardware opens.
		if *command != "open" {
			host.app.Quit()
			return
		}
		backend, err = NewBackend(*mode, *writes, root)
		if err != nil {
			host.record("startup-failed", map[string]any{"error": err.Error()})
			host.app.Quit()
			return
		}
		host.backend = backend
		if backend.native != nil {
			backend.native.SetTrace(host.record)
			backend.native.notify = func(message string) {
				application.InvokeAsync(func() {
					noticeErr := showTrayWarning(message)
					host.record("tray-notice", map[string]any{"accepted": noticeErr == nil, "message": message, "error": errorText(noticeErr)})
					if noticeErr != nil {
						x, y := win32.CursorPosition()
						backend.native.desktop.ShowFeedback(desktop.Feedback{Label: "应用音量", Value: "请先播放音频", HideProgress: true, X: x, Y: y})
					}
				})
			}
			backend.native.production = *production
		}
		host.dispatch = newDispatcher(backend.Request, host.record)
		ipc, err = host.serveIPC()
		if err != nil {
			host.record("ipc-failed", map[string]any{"error": err.Error()})
			host.app.Quit()
			return
		}
		if backend.native != nil {
			if *production {
				executable, startupErr := os.Executable()
				if startupErr == nil {
					startupErr = startup.Configure(executable, backend.native.settings.LaunchOnStartup)
				}
				if startupErr != nil {
					host.record("startup-registration-failed", map[string]any{"error": startupErr.Error()})
					host.app.Quit()
					return
				}
			}
			backend.native.Start()
		}
		host.record("started", map[string]any{"pid": os.Getpid(), "mode": *mode, "dev": *dev})
		if !*background {
			host.open()
		}
	})
	if err = host.app.Run(); err != nil {
		log.Print(err)
	}
}

func (h *Host) record(event string, fields map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if fields == nil {
		fields = map[string]any{}
	}
	fields["event"] = event
	fields["at"] = time.Now().Format(time.RFC3339Nano)
	data, _ := json.Marshal(fields)
	h.logfile.Write(append(data, '\n'))
}
func (h *Host) control(action string) {
	switch action {
	case "open":
		h.open()
	case "close":
		application.InvokeSync(func() {
			if h.window != nil {
				h.window.Close()
			}
		})
	case "quit":
		h.app.Quit()
	}
}
func (h *Host) open() {
	application.InvokeSync(func() {
		if h.window != nil {
			if h.window.IsMinimised() {
				h.window.Restore()
			}
			h.window.Show()
			h.window.Focus()
			return
		}
		h.opened = time.Now()
		h.serial++
		serial := h.serial
		url := "/?language=zh-CN"
		title := "Monitors Focus · Dev · " + h.mode
		if h.production {
			title = "Monitors Focus"
		}
		w := h.app.Window.NewWithOptions(application.WebviewWindowOptions{Name: fmt.Sprintf("panel-%d", serial), Title: title, Width: 960, Height: 540, URL: url, Frameless: true, DisableResize: false, DevToolsEnabled: h.dev || h.inspect, BackgroundColour: application.NewRGB(247, 249, 252), Windows: application.WindowsWindow{NonClientRegionSupport: true}})
		h.window = w
		setFixedRatioWindow(uintptr(w.NativeWindow()))
		w.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
			clearFixedRatioWindow(uintptr(w.NativeWindow()))
			if h.window == w {
				h.window = nil
			}
			h.record("window-closed", map[string]any{"serial": serial})
		})
		w.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
			if err := setPanelIcon(uintptr(w.NativeWindow())); err != nil {
				h.record("window-icon-error", map[string]any{"error": err.Error()})
			}
			applyFixedRatioSize(uintptr(w.NativeWindow()), 960, 540)
			// STARTUPINFO can hide the first ShowWindow when the tray process was
			// launched with SW_HIDE. A later user open must explicitly show it.
			w.Show()
			w.Focus()
			h.record("runtime-ready", map[string]any{"serial": serial, "elapsedMs": time.Since(h.opened).Milliseconds()})
		})
		// Maximising and Windows snapping bypass WM_SIZING; return to the
		// one-window 16:9 stage after those system transitions finish.
		w.OnWindowEvent(events.Windows.WindowDidResize, func(*application.WindowEvent) {
			application.InvokeAsync(func() {
				if !isFixedRatioWindow(uintptr(w.NativeWindow())) || w.IsMinimised() {
					return
				}
				hwnd := uintptr(w.NativeWindow())
				if w.IsMaximised() {
					w.Restore()
				}
				frameX, frameY := windowFrame(hwnd)
				_, _, _, _, clientWidth, clientHeight := windowMetrics(hwnd, frameX, frameY)
				// Keep user resizing when its client area is already 16:9.
				if clientWidth > 0 && clientHeight > 0 && absRatioError(clientWidth, clientHeight) <= 16 {
					return
				}
				// Restore the single 16:9 stage after a snap, maximise or resize.
				applyFixedRatioSize(hwnd, panelClientWide, panelClientHigh)
				w.Center()
			})
		})
		h.record("window-created", map[string]any{"serial": serial})
	})
}

func (h *Host) receive(w application.Window, message string, origin *application.OriginInfo) {
	expected := "http://wails.localhost"
	// Windows 3.1.0 supplies full URLs and leaves IsMainFrame unset. Validate both
	// authoritative URLs, require equality, and forbid all frames through CSP.
	if origin == nil || !trustedURL(origin.Origin, expected) || !trustedURL(origin.TopOrigin, expected) || origin.Origin != origin.TopOrigin {
		h.record("origin-rejected", map[string]any{"origin": origin})
		return
	}
	var msg Message
	if len(message) > 1<<20 || json.Unmarshal([]byte(message), &msg) != nil || len(msg.Id) > 80 || msg.Id == "" {
		return
	}
	switch msg.Request.Action {
	case "window-minimise", "window-maximise", "window-close":
		application.InvokeAsync(func() {
			switch msg.Request.Action {
			case "window-minimise":
				w.Minimise()
			case "window-maximise":
				// A 16:9 stage has no separate maximised layout. Keep the
				// button useful by returning a moved/resized window to centre.
				if w.IsMaximised() {
					w.Restore()
				}
				applyFixedRatioSize(uintptr(w.NativeWindow()), 960, 540)
				w.Center()
			case "window-close":
				w.Close()
			}
		})
		return
	case "window":
		// Both pages now share a fixed 16:9 window; recentre on page changes.
		application.InvokeAsync(func() { w.Center() })
		return
	case "ui-ready":
		h.record("ui-ready", map[string]any{"serial": h.serial, "elapsedMs": time.Since(h.opened).Milliseconds()})
		return
	case "ui-trace":
		h.record("ui-complete", map[string]any{"traceId": msg.Id, "action": msg.Request.Id, "elapsedMs": msg.Request.Value})
		return
	}
	h.record("ui-received", map[string]any{"traceId": msg.Id, "action": msg.Request.Action, "deviceId": msg.Request.Id})
	send := func(reply Reply) {
		data, _ := json.Marshal(reply)
		// Shutdown hooks run on Wails' UI thread: never block the dispatcher on it.
		application.InvokeAsync(func() {
			w.ExecJS("window.dispatchEvent(new CustomEvent('monitor-focus-reply',{detail:" + string(data) + "}))")
		})
	}
	if err := h.dispatch.enqueue(msg.Request, msg.Id, send); err != nil {
		send(Reply{Id: msg.Id, Error: err.Error()})
	}
}

func trustedURL(raw, expected string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.User == nil && u.Scheme+"://"+u.Host == expected
}
