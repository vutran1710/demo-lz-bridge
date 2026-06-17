package executor

import "testing"

func TestScheduler_withholdsUntilPriorDone(t *testing.T) {
	s := NewScheduler()
	ch := "A->B:app"
	// enqueue out of order: 2 then 1
	s.Add(ch, Item{Nonce: 2})
	s.Add(ch, Item{Nonce: 1})

	// only nonce 1 is ready (2 withheld)
	it, ok := s.Ready(ch)
	if !ok || it.Nonce != 1 {
		t.Fatalf("expected nonce 1 ready, got ok=%v nonce=%d", ok, it.Nonce)
	}
	// 2 still not ready until 1 done
	s.Done(ch, 1)
	it, ok = s.Ready(ch)
	if !ok || it.Nonce != 2 {
		t.Fatalf("expected nonce 2 ready after 1 done, got ok=%v nonce=%d", ok, it.Nonce)
	}
	s.Done(ch, 2)
	if _, ok := s.Ready(ch); ok {
		t.Fatalf("expected nothing ready after all done")
	}
}

func TestScheduler_independentChannels(t *testing.T) {
	s := NewScheduler()
	s.Add("A->B", Item{Nonce: 1})
	s.Add("C->D", Item{Nonce: 1})
	if _, ok := s.Ready("A->B"); !ok {
		t.Error("A->B nonce 1 should be ready")
	}
	if _, ok := s.Ready("C->D"); !ok {
		t.Error("C->D nonce 1 should be ready")
	}
	if len(s.Channels()) != 2 {
		t.Errorf("expected 2 active channels, got %d", len(s.Channels()))
	}
}

func TestScheduler_dropsStaleAdds(t *testing.T) {
	s := NewScheduler()
	ch := "A->B"
	s.Add(ch, Item{Nonce: 1})
	s.Done(ch, 1)
	s.Add(ch, Item{Nonce: 1}) // already executed → ignored
	if _, ok := s.Ready(ch); ok {
		t.Error("stale nonce 1 should not be re-queued")
	}
}
