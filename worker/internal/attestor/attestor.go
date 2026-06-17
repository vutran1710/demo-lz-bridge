package attestor

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/onematrix/bridge/worker/internal/chain"
	"github.com/onematrix/bridge/worker/internal/config"
	"github.com/onematrix/bridge/worker/internal/packet"
	"github.com/onematrix/bridge/worker/internal/pathway"
	"github.com/onematrix/bridge/worker/internal/store"
	"github.com/onematrix/bridge/worker/internal/submit"
)

type Attestor struct {
	cfg *config.Config
}

func New(cfg *config.Config) *Attestor {
	return &Attestor{cfg: cfg}
}

// Run services every configured pathway concurrently with one DVN identity (same key across
// chains). Each pathway: watch source PacketSent → submit verify() on its destination. Verify only.
func (a *Attestor) Run(ctx context.Context) error {
	pws, err := pathway.Load()
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	for _, pw := range pws {
		wg.Add(1)
		go func(pw pathway.Pathway) {
			defer wg.Done()
			if err := a.runPathway(ctx, pw); err != nil && ctx.Err() == nil {
				log.Printf("[%s] pathway %s error: %v", a.cfg.AttestorID, pw.ID, err)
			}
		}(pw)
	}
	wg.Wait()
	return nil
}

func (a *Attestor) runPathway(ctx context.Context, pw pathway.Pathway) error {
	clients, err := chain.Dial(pw.SrcRPC, pw.DstRPC)
	if err != nil {
		return err
	}
	sub, err := submit.New(ctx, clients.Dst, common.HexToAddress(pw.DstReceiveLib), a.cfg.PrivateKey)
	if err != nil {
		return err
	}
	cursor := store.NewCursor(a.cfg.CursorPath + "." + pw.ID)
	last := cursor.Load()
	verified := map[string]bool{}

	t := time.NewTicker(time.Duration(a.cfg.PollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			a.tick(ctx, pw, clients, sub, cursor, &last, verified)
		}
	}
}

func (a *Attestor) tick(
	ctx context.Context,
	pw pathway.Pathway,
	clients *chain.Clients,
	sub *submit.Submitter,
	cursor *store.Cursor,
	last *uint64,
	verified map[string]bool,
) {
	head, err := clients.HeadBlock(ctx)
	if err != nil || head+1 < pw.Confirmations {
		return
	}
	safe := head + 1 - pw.Confirmations
	if safe <= *last {
		return
	}
	logs, err := clients.FilterPacketSent(ctx, *last+1, safe)
	if err != nil {
		return
	}
	hadError := false
	for _, enc := range logs {
		p, perr := packet.Parse(enc)
		if perr != nil {
			continue
		}
		guid := p.Guid.Hex()
		if verified[guid] {
			continue
		}
		if err := sub.Verify(ctx, p.Header, p.PayloadHash, pw.Confirmations); err != nil {
			log.Printf("[%s] verify %s nonce=%d failed: %v", a.cfg.AttestorID, pw.ID, p.Nonce, err)
			hadError = true
			continue
		}
		verified[guid] = true
	}
	if !hadError {
		*last = safe
		_ = cursor.Save(*last)
	}
}
