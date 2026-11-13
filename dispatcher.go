package main

import (
	"errors"
	"sync"
	"time"
)

// The receive callback enqueues synchronously. Only adjacent pending slider
// commands for the same control merge; snapshots/save/other devices are barriers.
type delivery struct {
	id     string
	reply  func(Reply)
	queued time.Time
}
type command struct {
	request    Request
	deliveries []delivery
}
type dispatcher struct {
	mu     sync.Mutex
	ready  *sync.Cond
	queue  []command
	closed bool
	done   chan struct{}
	handle func(Request) (map[string]any, error)
	trace  func(string, map[string]any)
}

func newDispatcher(handle func(Request) (map[string]any, error), trace func(string, map[string]any)) *dispatcher {
	d := &dispatcher{handle: handle, trace: trace, done: make(chan struct{})}
	d.ready = sync.NewCond(&d.mu)
	go d.run()
	return d
}
func (d *dispatcher) enqueue(r Request, id string, reply func(Reply)) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return errors.New("正在退出")
	}
	waiter := delivery{id, reply, time.Now()}
	r.TraceID = id
	if len(d.queue) > 0 && (r.Action == "brightness" || r.Action == "temperature") {
		last := &d.queue[len(d.queue)-1]
		if last.request.Action == r.Action && last.request.Id == r.Id {
			last.request = r
			last.deliveries = append(last.deliveries, waiter)
			d.ready.Signal()
			return nil
		}
	}
	if len(d.queue) >= 128 {
		return errors.New("调节请求过多，请稍后重试")
	}
	d.queue = append(d.queue, command{r, []delivery{waiter}})
	d.ready.Signal()
	return nil
}
func (d *dispatcher) run() {
	defer close(d.done)
	for {
		d.mu.Lock()
		for len(d.queue) == 0 && !d.closed {
			d.ready.Wait()
		}
		if len(d.queue) == 0 && d.closed {
			d.mu.Unlock()
			return
		}
		job := d.queue[0]
		d.queue[0] = command{}
		d.queue = d.queue[1:]
		d.mu.Unlock()
		start := time.Now()
		if d.trace != nil {
			d.trace("command-start", map[string]any{"traceId": job.request.TraceID, "action": job.request.Action, "deviceId": job.request.Id, "queueMs": start.Sub(job.deliveries[len(job.deliveries)-1].queued).Milliseconds(), "merged": len(job.deliveries) - 1})
		}
		state, err := d.handle(job.request)
		for _, waiter := range job.deliveries {
			reply := Reply{Id: waiter.id, Snapshot: state}
			if err != nil {
				reply.Error = err.Error()
				reply.Snapshot = nil
			}
			if d.trace != nil {
				d.trace("command-end", map[string]any{"traceId": waiter.id, "appliedTraceId": job.request.TraceID, "action": job.request.Action, "elapsedMs": time.Since(waiter.queued).Milliseconds(), "serviceMs": time.Since(start).Milliseconds(), "error": reply.Error})
			}
			waiter.reply(reply)
		}
	}
}
func (d *dispatcher) close() {
	d.mu.Lock()
	d.closed = true
	d.ready.Broadcast()
	d.mu.Unlock()
	<-d.done
}
