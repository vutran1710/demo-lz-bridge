package executor

import (
	"hash/fnv"
	"sort"
	"sync"
)

// Pool assigns each channel to exactly one signer (by consistent hash over the live set), so a
// channel's ordered deliveries never race across signers, while distinct channels run in parallel.
// On a signer death its channels deterministically re-lease to a live signer.
type Pool struct {
	mu   sync.Mutex
	ids  []string        // all signer ids, sorted
	dead map[string]bool
}

func NewPool(ids []string) *Pool {
	cp := append([]string(nil), ids...)
	sort.Strings(cp)
	return &Pool{ids: cp, dead: map[string]bool{}}
}

func (p *Pool) live() []string {
	out := make([]string, 0, len(p.ids))
	for _, id := range p.ids {
		if !p.dead[id] {
			out = append(out, id)
		}
	}
	return out
}

// Lease returns the signer id responsible for a channel. Stable while membership is stable.
func (p *Pool) Lease(channel string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	live := p.live()
	if len(live) == 0 {
		return "", false
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(channel))
	return live[h.Sum32()%uint32(len(live))], true
}

// MarkDead removes a signer; its channels re-lease to a live signer on the next Lease.
func (p *Pool) MarkDead(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dead[id] = true
}

// Revive restores a previously-dead signer.
func (p *Pool) Revive(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.dead, id)
}
