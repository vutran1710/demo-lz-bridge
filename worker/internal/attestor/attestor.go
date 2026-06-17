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

// pending tracks a verified-but-not-yet-committed packet so commit can be retried each tick
// until the M-of-N threshold is reached by the set.
type pending struct {
	header  []byte
	payload common.Hash
}

// Run watches the source chain for PacketSent, submits this attestor's verify on the destination,
// and opportunistically commits once the threshold is met. Idempotent and gap-free on restart.
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
	queue := map[string]pending{} // guid hex -> pending (verified, awaiting commit)
	verifiedGuids := map[string]bool{}

	t := time.NewTicker(time.Duration(a.cfg.PollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			a.tick(ctx, clients, sub, cursor, &last, queue, verifiedGuids)
		}
	}
}

func (a *Attestor) tick(
	ctx context.Context,
	clients *chain.Clients,
	sub *submit.Submitter,
	cursor *store.Cursor,
	last *uint64,
	queue map[string]pending,
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
	if safe > *last {
		encodedList, err := clients.FilterPacketSent(ctx, *last+1, safe)
		if err == nil {
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
				queue[guid] = pending{header: p.Header, payload: p.PayloadHash}
			}
			// advance the cursor only when the whole batch was verified; otherwise re-scan the
			// range next tick (already-verified packets are skipped via verifiedGuids).
			if !hadError {
				*last = safe
				_ = cursor.Save(*last)
			}
		}
	}

	// opportunistically commit anything whose threshold may now be met
	for guid, p := range queue {
		headerHash := submit.HeaderHash(p.header)
		done, err := sub.IsCommitted(ctx, headerHash, p.payload)
		if err != nil {
			continue
		}
		if done {
			delete(queue, guid)
			continue
		}
		if err := sub.Commit(ctx, p.header, p.payload); err != nil {
			// threshold not met yet or already committed by another — retry/clear next tick
			continue
		}
		delete(queue, guid)
	}
}
