package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
	"monitorsfocus/internal/win32"
)

type ipcServer struct {
	listener    net.Listener
	mu          sync.Mutex
	connections map[net.Conn]struct{}
	closed      bool
	done        chan struct{}
	wg          sync.WaitGroup
}

func (h *Host) serveIPC() (*ipcServer, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	listener, err := winio.ListenPipe(`\\.\pipe\MonitorsFocus.Go.Control.`+os.Getenv("USERNAME")+"."+h.mode, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + user.User.Sid.String() + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
	if err != nil {
		return nil, err
	}
	s := &ipcServer{listener: listener, connections: map[net.Conn]struct{}{}, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				conn.Close()
				return
			}
			s.connections[conn] = struct{}{}
			s.wg.Add(1)
			s.mu.Unlock()
			go func() {
				defer s.wg.Done()
				defer conn.Close()
				defer func() { s.mu.Lock(); delete(s.connections, conn); s.mu.Unlock() }()
				h.handleIPC(conn)
			}()
		}
	}()
	return s, nil
}
func (s *ipcServer) close() {
	s.mu.Lock()
	s.closed = true
	s.listener.Close()
	for conn := range s.connections {
		conn.Close()
	}
	s.mu.Unlock()
	<-s.done
	s.wg.Wait()
}
func (h *Host) handleIPC(conn net.Conn) {
	conn.SetDeadline(time.Now().Add(15 * time.Second))
	fd, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return
	}
	var pid, session, current uint32
	if !win32.Console() || windows.GetNamedPipeClientProcessId(windows.Handle(fd.Fd()), &pid) != nil || windows.ProcessIdToSessionId(pid, &session) != nil || windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &current) != nil || session != current {
		return
	}
	line, err := bufio.NewReader(io.LimitReader(conn, (1<<20)+1)).ReadBytes('\n')
	if err != nil || len(line) > 1<<20 {
		return
	}
	var msg Message
	if json.Unmarshal(line, &msg) != nil || msg.Id == "" || len(msg.Id) > 80 {
		return
	}
	if msg.Request.Action == "host-exit" {
		json.NewEncoder(conn).Encode(Reply{Id: msg.Id, Snapshot: map[string]any{"Exiting": true}})
		application.InvokeAsync(h.app.Quit)
		return
	}
	if msg.Request.Action == "host-memory" || msg.Request.Action == "host-memory-reclaim" {
		state, err := memoryDiagnostics(msg.Request.Action == "host-memory-reclaim")
		reply := Reply{Id: msg.Id, Snapshot: state}
		if err != nil {
			reply.Error = err.Error()
		}
		json.NewEncoder(conn).Encode(reply)
		return
	}
	if msg.Request.Action == "host-notice-check" {
		checked := make(chan error, 1)
		application.InvokeAsync(func() {
			err := showTrayWarning("当前软件没有可调节的音频会话，请先播放音频。")
			h.record("tray-notice-check", map[string]any{"accepted": err == nil, "error": errorText(err)})
			checked <- err
		})
		select {
		case err := <-checked:
			if err != nil {
				json.NewEncoder(conn).Encode(Reply{Id: msg.Id, Error: err.Error()})
			} else {
				json.NewEncoder(conn).Encode(Reply{Id: msg.Id, Snapshot: map[string]any{"Accepted": true}})
			}
		case <-time.After(3 * time.Second):
			json.NewEncoder(conn).Encode(Reply{Id: msg.Id, Error: "notification check timed out"})
		}
		return
	}
	if msg.Request.Action == "host-open" || msg.Request.Action == "host-close" {
		action := "open"
		if msg.Request.Action == "host-close" {
			action = "close"
		}
		application.InvokeAsync(func() { h.control(action) })
		json.NewEncoder(conn).Encode(Reply{Id: msg.Id, Snapshot: map[string]any{"Host": action}})
		return
	}
	done := make(chan Reply, 1)
	h.record("ipc-received", map[string]any{"traceId": msg.Id, "action": msg.Request.Action, "clientPid": pid})
	if err := h.dispatch.enqueue(msg.Request, msg.Id, func(reply Reply) { done <- reply }); err != nil {
		json.NewEncoder(conn).Encode(Reply{Id: msg.Id, Error: err.Error()})
		return
	}
	select {
	case reply := <-done:
		json.NewEncoder(conn).Encode(reply)
	case <-time.After(12 * time.Second):
		json.NewEncoder(conn).Encode(Reply{Id: msg.Id, Error: "响应超时，硬件调用仍将排空"})
	}
}
func nativeCall(mode, payload string) error {
	conn, err := winio.DialPipe(`\\.\pipe\MonitorsFocus.Go.Control.`+os.Getenv("USERNAME")+"."+mode, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(15 * time.Second))
	var request Request
	if err = json.Unmarshal([]byte(payload), &request); err != nil {
		return err
	}
	msg := Message{Id: fmt.Sprintf("cli-%d-%d", os.Getpid(), time.Now().UnixNano()), Request: request}
	if err = json.NewEncoder(conn).Encode(msg); err != nil {
		return err
	}
	var reply Reply
	if err = json.NewDecoder(io.LimitReader(conn, 2<<20)).Decode(&reply); err != nil {
		return err
	}
	json.NewEncoder(os.Stdout).Encode(reply)
	if reply.Error != "" {
		return errors.New(reply.Error)
	}
	return nil
}
