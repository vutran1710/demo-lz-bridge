package executor

import "sync"

// Item is a message awaiting delivery on a channel.
type Item struct {
	Header      []byte
	Guid        [32]byte
	Message     []byte
	PayloadHash [32]byte
	Nonce       uint64
}

// Scheduler enforces per-channel ordered delivery: nonce n+1 is not released until n is Done.
// Different channels are independent (the pool runs them in parallel).
type Scheduler struct {
	mu       sync.Mutex
	executed map[string]uint64          // channel => last executed nonce
	pending  map[string]map[uint64]Item // channel => nonce => item
}

func NewScheduler() *Scheduler {
	return &Scheduler{executed: map[string]uint64{}, pending: map[string]map[uint64]Item{}}
}

// Add queues an item for a channel (idempotent per nonce) and reports whether it was newly added.
func (s *Scheduler) Add(channel string, it Item) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending[channel] == nil {
		s.pending[channel] = map[uint64]Item{}
	}
	if it.Nonce <= s.executed[channel] {
		return false
	}
	if _, exists := s.pending[channel][it.Nonce]; exists {
		return false
	}
	s.pending[channel][it.Nonce] = it
	return true
}

// Ready returns the next executable item for a channel (executed+1), if present.
func (s *Scheduler) Ready(channel string) (Item, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.executed[channel] + 1
	it, ok := s.pending[channel][next]
	return it, ok
}

// Done marks a nonce delivered, advancing the channel cursor and dropping the item.
func (s *Scheduler) Done(channel string, nonce uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if nonce == s.executed[channel]+1 {
		s.executed[channel] = nonce
		delete(s.pending[channel], nonce)
	}
}

// Channels returns the channels with pending work.
func (s *Scheduler) Channels() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.pending))
	for c, m := range s.pending {
		if len(m) > 0 {
			out = append(out, c)
		}
	}
	return out
}
