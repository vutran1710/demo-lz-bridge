package executor

import "testing"

func TestPool_stableLease(t *testing.T) {
	p := NewPool([]string{"s1", "s2", "s3"})
	a, ok := p.Lease("A->B")
	if !ok {
		t.Fatal("expected a lease")
	}
	b, _ := p.Lease("A->B")
	if a != b {
		t.Errorf("lease not stable: %s vs %s", a, b)
	}
}

func TestPool_distributesChannels(t *testing.T) {
	p := NewPool([]string{"s1", "s2", "s3"})
	seen := map[string]bool{}
	for _, ch := range []string{"A->B", "C->D", "E->F", "G->H", "I->J", "K->L"} {
		id, _ := p.Lease(ch)
		seen[id] = true
	}
	if len(seen) < 2 {
		t.Errorf("expected channels spread across signers, got %d distinct", len(seen))
	}
}

func TestPool_reLeasesOnDeath(t *testing.T) {
	p := NewPool([]string{"s1", "s2", "s3"})
	ch := "A->B"
	owner, _ := p.Lease(ch)
	p.MarkDead(owner)
	newOwner, ok := p.Lease(ch)
	if !ok {
		t.Fatal("expected a live signer after death")
	}
	if newOwner == owner {
		t.Errorf("channel should re-lease away from dead signer %s", owner)
	}
}

func TestPool_noLiveSigners(t *testing.T) {
	p := NewPool([]string{"s1"})
	p.MarkDead("s1")
	if _, ok := p.Lease("A->B"); ok {
		t.Error("expected no lease when all signers dead")
	}
}
