package attestor

import (
	"context"
	"time"

	"github.com/onematrix/bridge/worker/internal/config"
)

type Attestor struct {
	cfg *config.Config
}

func New(cfg *config.Config) *Attestor {
	return &Attestor{cfg: cfg}
}

// Run is the P0 skeleton: it idles until the context is cancelled and does no work.
// The watch -> finality -> recompute -> submit loop is implemented in P3.
func (a *Attestor) Run(ctx context.Context) error {
	t := time.NewTicker(time.Duration(a.cfg.PollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			// P3: watch source PacketSent -> wait finality -> recompute payloadHash -> submit verify
		}
	}
}
