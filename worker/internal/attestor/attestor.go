package attestor

import (
	"context"
	"log"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/onematrix/bridge/worker/internal/chain"
	"github.com/onematrix/bridge/worker/internal/config"
	"github.com/onematrix/bridge/worker/internal/packet"
	"github.com/onematrix/bridge/worker/internal/store"
	"github.com/onematrix/bridge/worker/internal/submit"
)

type Attestor struct {
	cfg *config.Config
}

func New(cfg *config.Config) *Attestor {
	return &Attestor{cfg: cfg}
}

// Run watches the source chain for PacketSent and submits THIS attestor's verify() on the
// destination. Verification only — committing the verified message onto the destination channel
// and delivering it are the Executor's responsibility (separation of concerns, P4). Gap-free and
// idempotent across restarts.
func (a *Attestor) Run(ctx context.Context) error {
	clients, err := chain.Dial(a.cfg.SrcRPC, a.cfg.DstRPC)
	if err != nil {
		return err
	}
	sub, err := submit.New(ctx, clients.Dst, common.HexToAddress(a.cfg.DstReceiveLib), a.cfg.PrivateKey)
	if err != nil {
		return err
	}
	cursor := store.NewCursor(a.cfg.CursorPath)
	last := cursor.Load()
	verifiedGuids := map[string]bool{}

	t := time.NewTicker(time.Duration(a.cfg.PollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			a.tick(ctx, clients, sub, cursor, &last, verifiedGuids)
		}
	}
}

func (a *Attestor) tick(
	ctx context.Context,
	clients *chain.Clients,
	sub *submit.Submitter,
	cursor *store.Cursor,
	last *uint64,
	verifiedGuids map[string]bool,
) {
	head, err := clients.HeadBlock(ctx)
	if err != nil {
		return
	}
	if head+1 < a.cfg.Confirmations {
		return
	}
	safe := head + 1 - a.cfg.Confirmations
	if safe <= *last {
		return
	}
	encodedList, err := clients.FilterPacketSent(ctx, *last+1, safe)
	if err != nil {
		return
	}
	hadError := false
	for _, encoded := range encodedList {
		p, perr := packet.Parse(encoded)
		if perr != nil {
			continue
		}
		guid := p.Guid.Hex()
		if verifiedGuids[guid] {
			continue // already verified by this attestor; don't re-send
		}
		// each attestor recomputes and submits its own verify (R-VF-1)
		if err := sub.Verify(ctx, p.Header, p.PayloadHash, a.cfg.Confirmations); err != nil {
			log.Printf("[%s] verify nonce=%d failed: %v", a.cfg.AttestorID, p.Nonce, err)
			hadError = true
			continue
		}
		verifiedGuids[guid] = true
	}
	// advance the cursor only when the whole batch was verified; otherwise re-scan next tick
	// (already-verified packets are skipped via verifiedGuids).
	if !hadError {
		*last = safe
		_ = cursor.Save(*last)
	}
}
