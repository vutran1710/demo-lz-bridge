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
	"github.com/onematrix/bridge/worker/internal/status"
	"github.com/onematrix/bridge/worker/internal/store"
	"github.com/onematrix/bridge/worker/internal/submit"
)

type Attestor struct {
	cfg      *config.Config
	reporter *status.Reporter
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
	a.reporter = status.New(a.cfg.AttestorID, "dvn", len(pws))
	a.reporter.Serve(ctx, a.cfg.StatusAddr)
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
	seen := map[string]bool{}

	t := time.NewTicker(time.Duration(a.cfg.PollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			a.tick(ctx, pw, clients, sub, cursor, &last, verified, seen)
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
	seen map[string]bool,
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
		if pw.DstEid != 0 && p.DstEid != pw.DstEid {
			continue // packet bound for a different destination; another pathway handles it
		}
		guid := p.Guid.Hex()
		if !seen[guid] {
			seen[guid] = true
			a.reporter.Event(status.Event{
				Pathway:         pw.ID,
				Action:          "observe-packet",
				Status:          "observed",
				Contract:        "SendLib",
				Method:          "PacketSent",
				ContractAddress: "",
				Guid:            guid,
				Nonce:           p.Nonce,
				SrcEid:          p.SrcEid,
				DstEid:          p.DstEid,
				Sender:          common.BytesToAddress(p.Sender[12:]).Hex(),
				Receiver:        p.Receiver.Hex(),
				PayloadHash:     p.PayloadHash.Hex(),
				Detail:          "source PacketSent observed by attestor",
			})
		}
		if verified[guid] {
			continue
		}
		txHash, err := sub.Verify(ctx, p.Header, p.PayloadHash, pw.Confirmations)
		if err != nil {
			a.reporter.Event(status.Event{
				Pathway:         pw.ID,
				Action:          "submit-verify",
				Status:          "failed",
				Contract:        "ReceiveLib",
				Method:          "verify",
				ContractAddress: pw.DstReceiveLib,
				Guid:            guid,
				Nonce:           p.Nonce,
				SrcEid:          p.SrcEid,
				DstEid:          p.DstEid,
				Sender:          common.BytesToAddress(p.Sender[12:]).Hex(),
				Receiver:        p.Receiver.Hex(),
				PayloadHash:     p.PayloadHash.Hex(),
				Error:           err.Error(),
				Detail:          "attestor verify submission failed",
			})
			log.Printf("[%s] verify %s nonce=%d failed: %v", a.cfg.AttestorID, pw.ID, p.Nonce, err)
			hadError = true
			continue
		}
		verified[guid] = true
		a.reporter.Event(status.Event{
			Pathway:         pw.ID,
			Action:          "submit-verify",
			Status:          "submitted",
			Contract:        "ReceiveLib",
			Method:          "verify",
			ContractAddress: pw.DstReceiveLib,
			TxHash:          txHash.Hex(),
			Guid:            guid,
			Nonce:           p.Nonce,
			SrcEid:          p.SrcEid,
			DstEid:          p.DstEid,
			Sender:          common.BytesToAddress(p.Sender[12:]).Hex(),
			Receiver:        p.Receiver.Hex(),
			PayloadHash:     p.PayloadHash.Hex(),
			Detail:          "attestor submitted ReceiveLib.verify",
		})
		a.reporter.Inc()
	}
	if !hadError {
		*last = safe
		_ = cursor.Save(*last)
	}
}
