//go:build windows

package audio

import (
	"errors"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWorkerSerializesAndPinsCOMLifetime(t *testing.T) {
	var owner uint32
	var cleaned atomic.Bool
	c, err := startController(func() (*worker, func(), error) {
		owner = windows.GetCurrentThreadId()
		return &worker{}, func() {
			if windows.GetCurrentThreadId() != owner {
				t.Error("cleanup moved OS threads")
			}
			cleaned.Store(true)
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	var active, calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.call(func(*worker) (State, error) {
				if windows.GetCurrentThreadId() != owner {
					t.Error("job moved OS threads")
				}
				if active.Add(1) != 1 {
					t.Error("overlapping jobs")
				}
				runtime.Gosched()
				calls.Add(1)
				active.Add(-1)
				return State{}, nil
			})
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 40 || !cleaned.Load() {
		t.Fatal("jobs or cleanup missing")
	}
	if _, err := c.call(nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed call: %v", err)
	}
}

func TestCloseCancelsQueueAndDrainsInFlightBeforeCleanup(t *testing.T) {
	cleaned := make(chan struct{})
	c, err := startController(func() (*worker, func(), error) { return &worker{}, func() { close(cleaned) }, nil })
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		_, err := c.call(func(*worker) (State, error) { close(started); <-release; return State{}, ErrClosed })
		first <- err
	}()
	<-started
	queued := job{reply: make(chan result, 1), run: func(*worker) (State, error) { t.Error("queued job ran after Close"); return State{}, nil }}
	c.mu.Lock()
	c.jobs <- queued
	c.mu.Unlock()
	closed := make(chan error, 1)
	go func() { closed <- c.Close() }()
	deadline := time.Now().Add(3 * time.Second)
	for !c.stopping.Load() && time.Now().Before(deadline) {
		runtime.Gosched()
	}
	stopping := c.stopping.Load()
	select {
	case <-cleaned:
		t.Error("released resources while native call was in flight")
	default:
	}
	close(release)
	if !stopping {
		t.Error("Close did not reject new work promptly")
	}
	if err := <-first; !errors.Is(err, ErrClosed) {
		t.Error(err)
	}
	if err := (<-queued.reply).err; !errors.Is(err, ErrClosed) {
		t.Error(err)
	}
	if err := <-closed; err != nil {
		t.Error(err)
	}
	select {
	case <-cleaned:
	default:
		t.Error("Close returned before cleanup")
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestInitializationFailure(t *testing.T) {
	want := errors.New("COM initialization failure")
	c, err := startController(func() (*worker, func(), error) { return nil, nil, want })
	if c != nil || !errors.Is(err, want) {
		t.Fatalf("%v, %v", c, err)
	}
}

func TestNativeLayoutsAndHRESULT(t *testing.T) {
	if runtime.GOARCH == "amd64" && (unsafe.Sizeof(propVariant{}) != 24 || unsafe.Offsetof(propVariant{}.String) != 8 || unsafe.Sizeof(propertyKey{}) != 20) {
		t.Fatal("CoreAudio property ABI changed")
	}
	if hresult("S_FALSE", 1) != nil || hresult("failure", 0x80004005) == nil {
		t.Fatal("incorrect HRESULT success handling")
	}
}

// Explicit read-only smoke test. Never creates streams or calls any setter.
func TestNativeReadOnly(t *testing.T) {
	if os.Getenv("MONITORSFOCUS_AUDIO_READONLY") != "1" {
		t.Skip("opt-in native read-only probe")
	}
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	state, err := c.SystemVolume()
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePercent(state.Percent); err != nil || state.Name == "" {
		t.Fatalf("invalid state: %+v, %v", state, err)
	}
	t.Logf("read-only endpoint: %+v", state)
	if _, err := c.ApplicationVolume(0); !errors.Is(err, ErrNoTarget) {
		t.Fatalf("invalid window must be rejected: %v", err)
	}
	app, err := c.ApplicationVolume(ForegroundWindow())
	if err != nil && !errors.Is(err, ErrNoSessions) && !errors.Is(err, ErrNoTarget) && !errors.Is(err, ErrStaleTarget) {
		t.Fatalf("read-only application discovery: %v", err)
	}
	t.Logf("read-only foreground: %+v, %v", app, err)
}
