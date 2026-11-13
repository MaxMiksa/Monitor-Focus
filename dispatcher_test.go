package main

import (
	"reflect"
	"sync"
	"testing"
)

func TestDispatcherPreservesBarriersAndLatestSlider(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var applied []string
	d := newDispatcher(func(r Request) (map[string]any, error) {
		if r.Action == "first" {
			close(started)
			<-release
		}
		applied = append(applied, r.TraceID)
		return map[string]any{"applied": r.TraceID}, nil
	}, nil)
	var replies sync.WaitGroup
	send := func(action, id, trace string) {
		replies.Add(1)
		if err := d.enqueue(Request{Action: action, Id: id}, trace, func(Reply) { replies.Done() }); err != nil {
			t.Fatal(err)
		}
	}
	send("first", "", "first")
	<-started
	send("brightness", "a", "a1")
	send("brightness", "a", "a2")
	send("snapshot", "", "barrier")
	send("brightness", "a", "a3")
	send("brightness", "b", "b1")
	close(release)
	replies.Wait()
	d.close()
	if !reflect.DeepEqual(applied, []string{"first", "a2", "barrier", "a3", "b1"}) {
		t.Fatal(applied)
	}
	if err := d.enqueue(Request{}, "late", func(Reply) {}); err == nil {
		t.Fatal("accepted after close")
	}
}
