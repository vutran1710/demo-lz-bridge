package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/onematrix/bridge/worker/internal/chain"
	"github.com/onematrix/bridge/worker/internal/packet"
	"github.com/onematrix/bridge/worker/internal/pathway"
	"github.com/onematrix/bridge/worker/internal/signer"
	"github.com/onematrix/bridge/worker/internal/status"
)

// Config holds pathway-independent executor settings. Routing comes from the pathway package.
type Config struct {
	ID         string
	Keys       []string // signer pool (hex); reused per destination chain
	PollMs     int
	StatusAddr string // optional host:port for the /status endpoint
}

func Load() (*Config, error) {
	c := &Config{ID: envOr("EXECUTOR_ID", "exec"), PollMs: int(atou(os.Getenv("POLL_MS"), 100)), StatusAddr: os.Getenv("STATUS_ADDR")}
	for _, k := range strings.Split(os.Getenv("EXECUTOR_KEYS"), ",") {
		if s := strings.TrimSpace(k); s != "" {
			c.Keys = append(c.Keys, s)
		}
	}
	if len(c.Keys) == 0 {
		return nil, errors.New("missing EXECUTOR_KEYS")
	}
	return c, nil
}

type Executor struct{ cfg *Config }

func New(cfg *Config) *Executor { return &Executor{cfg: cfg} }

// Run services every configured pathway concurrently; each gets its own per-destination signer
// pool, scheduler and commit/deliver loop.
func (e *Executor) Run(ctx context.Context) error {
	pws, err := pathway.Load()
	if err != nil {
		return err
	}
	rep := status.New(e.cfg.ID, "executor", len(pws))
	rep.Serve(ctx, e.cfg.StatusAddr)
	var wg sync.WaitGroup
	for _, pw := range pws {
		r, err := e.newRunner(ctx, pw, rep)
		if err != nil {
			return err
		}
		wg.Add(1)
		go func() { defer wg.Done(); r.run(ctx) }()
	}
	wg.Wait()
	return nil
}

type runner struct {
	id            string
	clients       *chain.Clients
	reader        *Reader
	sched         *Scheduler
	pool          *Pool
	signers       map[string]*signer.Signer
	receiveLib    common.Address
	endpoint      common.Address
	confirmations uint64
	dstEid        uint32
	pollMs        int
	reporter      *status.Reporter

	mu      sync.Mutex
	running map[string]bool
	seen    map[string]bool
}

func (e *Executor) newRunner(ctx context.Context, pw pathway.Pathway, rep *status.Reporter) (*runner, error) {
	clients, err := chain.Dial(pw.SrcRPC, pw.DstRPC)
	if err != nil {
		return nil, err
	}
	receiveLib := common.HexToAddress(pw.DstReceiveLib)
	endpoint := common.HexToAddress(pw.DstEndpoint)
	reader, err := NewReader(clients.Dst, receiveLib, endpoint)
	if err != nil {
		return nil, err
	}
	r := &runner{
		id: e.cfg.ID + ":" + pw.ID, clients: clients, reader: reader, sched: NewScheduler(),
		signers: map[string]*signer.Signer{}, receiveLib: receiveLib, endpoint: endpoint,
		confirmations: pw.Confirmations, dstEid: pw.DstEid, pollMs: e.cfg.PollMs, running: map[string]bool{}, seen: map[string]bool{}, reporter: rep,
	}
	ids := []string{}
	for i, k := range e.cfg.Keys {
		id := fmt.Sprintf("%s#%d", r.id, i)
		s, err := signer.New(ctx, id, clients.Dst, k)
		if err != nil {
			return nil, err
		}
		r.signers[id] = s
		ids = append(ids, id)
	}
	r.pool = NewPool(ids)
	return r, nil
}

func (r *runner) run(ctx context.Context) {
	go r.watch(ctx)
	r.manage(ctx)
}

func (r *runner) watch(ctx context.Context) {
	var last uint64
	t := time.NewTicker(time.Duration(r.pollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			head, err := r.clients.HeadBlock(ctx)
			if err != nil || head+1 < r.confirmations {
				continue
			}
			safe := head + 1 - r.confirmations
			if safe <= last {
				continue
			}
			logs, err := r.clients.FilterPacketSent(ctx, last+1, safe)
			if err != nil {
				continue
			}
			for _, enc := range logs {
				p, perr := packet.Parse(enc)
				if perr != nil {
					continue
				}
				if r.dstEid != 0 && p.DstEid != r.dstEid {
					continue // bound for a different destination; another pathway handles it
				}
				guid := p.Guid.Hex()
				if !r.seen[guid] {
					r.seen[guid] = true
					r.reporter.Event(status.Event{
						Pathway:         pathwayID(r.id),
						Action:          "observe-packet",
						Status:          "observed",
						Contract:        "SendLib",
						Method:          "PacketSent",
						Guid:            guid,
						Nonce:           p.Nonce,
						SrcEid:          p.SrcEid,
						DstEid:          p.DstEid,
						Sender:          common.BytesToAddress(p.Sender[12:]).Hex(),
						Receiver:        p.Receiver.Hex(),
						PayloadHash:     p.PayloadHash.Hex(),
						Detail:          "source PacketSent observed by executor",
					})
				}
				added := r.sched.Add(channelKey(p), Item{
					Header: p.Header, Guid: p.Guid, Message: p.Message, PayloadHash: p.PayloadHash, Nonce: p.Nonce,
				})
				if added {
					r.reporter.Event(status.Event{
						Pathway:         pathwayID(r.id),
						Action:          "queue-delivery",
						Status:          "queued",
						Contract:        "Executor",
						Method:          "schedule",
						Guid:            guid,
						Nonce:           p.Nonce,
						SrcEid:          p.SrcEid,
						DstEid:          p.DstEid,
						Sender:          common.BytesToAddress(p.Sender[12:]).Hex(),
						Receiver:        p.Receiver.Hex(),
						PayloadHash:     p.PayloadHash.Hex(),
						Detail:          "executor queued packet for ordered delivery",
					})
				}
			}
			last = safe
		}
	}
}

func (r *runner) manage(ctx context.Context) {
	t := time.NewTicker(time.Duration(r.pollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, ch := range r.sched.Channels() {
				r.mu.Lock()
				if !r.running[ch] {
					r.running[ch] = true
					go r.worker(ctx, ch)
				}
				r.mu.Unlock()
			}
		}
	}
}

var errRetry = errors.New("retry")

func (r *runner) worker(ctx context.Context, channel string) {
	backoff := time.Duration(r.pollMs) * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}
		it, ok := r.sched.Ready(channel)
		if !ok {
			time.Sleep(backoff)
			continue
		}
		id, ok := r.pool.Lease(channel)
		if !ok {
			time.Sleep(backoff)
			continue
		}
		if err := r.deliver(ctx, r.signers[id], channel, it); err != nil {
			time.Sleep(backoff)
			continue
		}
		r.sched.Done(channel, it.Nonce)
		r.reporter.Inc()
	}
}

// deliver advances one message: commit (if needed, gap-free) then execute. Returns errRetry until done.
func (r *runner) deliver(ctx context.Context, sgn *signer.Signer, channel string, it Item) error {
	headerHash := crypto.Keccak256Hash(it.Header)
	srcEid, sender := decodeChannel(channel)
	receiver := channelReceiver(channel)
	committed, err := r.reader.Committed(ctx, headerHash, it.PayloadHash)
	if err != nil {
		return err
	}
	if !committed {
		v, err := r.reader.Verifiable(ctx, it.Header, it.PayloadHash)
		if err != nil || !v {
			return errRetry
		}
		r.reporter.Event(status.Event{
			Pathway:         pathwayID(r.id),
			Action:          "commit-ready",
			Status:          "ready",
			Contract:        "ReceiveLib",
			ContractAddress: r.receiveLib.Hex(),
			Method:          "commitVerification",
			Guid:            common.Hash(it.Guid).Hex(),
			Nonce:           it.Nonce,
			SrcEid:          srcEid,
			DstEid:          r.dstEid,
			Sender:          common.BytesToAddress(sender[12:]).Hex(),
			Receiver:        receiver.Hex(),
			PayloadHash:     common.Hash(it.PayloadHash).Hex(),
			Detail:          "attestor threshold met; executor can commit",
		})
		txHash, err := sgn.Commit(ctx, r.receiveLib, it.Header, common.Hash(it.PayloadHash))
		if err != nil {
			r.reporter.Event(status.Event{
				Pathway:         pathwayID(r.id),
				Action:          "submit-commit",
				Status:          "failed",
				Contract:        "ReceiveLib",
				ContractAddress: r.receiveLib.Hex(),
				Method:          "commitVerification",
				Guid:            common.Hash(it.Guid).Hex(),
				Nonce:           it.Nonce,
				SrcEid:          srcEid,
				DstEid:          r.dstEid,
				Sender:          common.BytesToAddress(sender[12:]).Hex(),
				Receiver:        receiver.Hex(),
				PayloadHash:     common.Hash(it.PayloadHash).Hex(),
				Error:           err.Error(),
				Detail:          "executor commit submission failed",
			})
			return errRetry
		}
		r.reporter.Event(status.Event{
			Pathway:         pathwayID(r.id),
			Action:          "submit-commit",
			Status:          "submitted",
			Contract:        "ReceiveLib",
			ContractAddress: r.receiveLib.Hex(),
			Method:          "commitVerification",
			TxHash:          txHash.Hex(),
			Guid:            common.Hash(it.Guid).Hex(),
			Nonce:           it.Nonce,
			SrcEid:          srcEid,
			DstEid:          r.dstEid,
			Sender:          common.BytesToAddress(sender[12:]).Hex(),
			Receiver:        receiver.Hex(),
			PayloadHash:     common.Hash(it.PayloadHash).Hex(),
			Detail:          "executor submitted ReceiveLib.commitVerification",
		})
		if !poll(ctx, func() bool { c, _ := r.reader.Committed(ctx, headerHash, it.PayloadHash); return c }) {
			return errRetry
		}
		r.reporter.Event(status.Event{
			Pathway:         pathwayID(r.id),
			Action:          "commit-observed",
			Status:          "confirmed",
			Contract:        "Endpoint",
			ContractAddress: r.endpoint.Hex(),
			Method:          "verify",
			Guid:            common.Hash(it.Guid).Hex(),
			Nonce:           it.Nonce,
			SrcEid:          srcEid,
			DstEid:          r.dstEid,
			Sender:          common.BytesToAddress(sender[12:]).Hex(),
			Receiver:        receiver.Hex(),
			PayloadHash:     common.Hash(it.PayloadHash).Hex(),
			Detail:          "destination endpoint marked packet verified",
		})
	}
	o := signer.Origin{SrcEid: srcEid, Sender: sender, Nonce: it.Nonce}
	txHash, err := sgn.Execute(ctx, r.endpoint, o, receiver, common.Hash(it.Guid), it.Message)
	if err != nil {
		r.reporter.Event(status.Event{
			Pathway:         pathwayID(r.id),
			Action:          "submit-execute",
			Status:          "failed",
			Contract:        "Endpoint",
			ContractAddress: r.endpoint.Hex(),
			Method:          "lzReceive",
			Guid:            common.Hash(it.Guid).Hex(),
			Nonce:           it.Nonce,
			SrcEid:          srcEid,
			DstEid:          r.dstEid,
			Sender:          common.BytesToAddress(sender[12:]).Hex(),
			Receiver:        receiver.Hex(),
			PayloadHash:     common.Hash(it.PayloadHash).Hex(),
			Error:           err.Error(),
			Detail:          "executor delivery submission failed",
		})
		return errRetry
	}
	r.reporter.Event(status.Event{
		Pathway:         pathwayID(r.id),
		Action:          "submit-execute",
		Status:          "submitted",
		Contract:        "Endpoint",
		ContractAddress: r.endpoint.Hex(),
		Method:          "lzReceive",
		TxHash:          txHash.Hex(),
		Guid:            common.Hash(it.Guid).Hex(),
		Nonce:           it.Nonce,
		SrcEid:          srcEid,
		DstEid:          r.dstEid,
		Sender:          common.BytesToAddress(sender[12:]).Hex(),
		Receiver:        receiver.Hex(),
		PayloadHash:     common.Hash(it.PayloadHash).Hex(),
		Detail:          "executor submitted Endpoint.lzReceive",
	})
	if !poll(ctx, func() bool {
		d, _ := r.reader.Delivered(ctx, receiver, srcEid, sender, it.Nonce, common.Hash(it.PayloadHash))
		return d
	}) {
		return errRetry
	}
	r.reporter.Event(status.Event{
		Pathway:         pathwayID(r.id),
		Action:          "delivery-observed",
		Status:          "confirmed",
		Contract:        "Endpoint",
		ContractAddress: r.endpoint.Hex(),
		Method:          "PacketDelivered",
		Guid:            common.Hash(it.Guid).Hex(),
		Nonce:           it.Nonce,
		SrcEid:          srcEid,
		DstEid:          r.dstEid,
		Sender:          common.BytesToAddress(sender[12:]).Hex(),
		Receiver:        receiver.Hex(),
		PayloadHash:     common.Hash(it.PayloadHash).Hex(),
		Detail:          "destination endpoint emitted PacketDelivered",
	})
	return nil
}

func poll(ctx context.Context, cond func() bool) bool {
	for i := 0; i < 100; i++ {
		if ctx.Err() != nil {
			return false
		}
		if cond() {
			return true
		}
		time.Sleep(30 * time.Millisecond)
	}
	return false
}

func channelKey(p packet.Parsed) string {
	return fmt.Sprintf("%d|%x|%s", p.SrcEid, p.Sender, p.Receiver.Hex())
}
func decodeChannel(channel string) (uint32, [32]byte) {
	parts := strings.SplitN(channel, "|", 3)
	eid, _ := strconv.ParseUint(parts[0], 10, 32)
	var sender [32]byte
	b := common.FromHex("0x" + parts[1])
	copy(sender[32-len(b):], b)
	return uint32(eid), sender
}
func channelReceiver(channel string) common.Address {
	parts := strings.SplitN(channel, "|", 3)
	return common.HexToAddress(parts[2])
}

func pathwayID(id string) string {
	if i := strings.IndexByte(id, ':'); i >= 0 && i+1 < len(id) {
		return id[i+1:]
	}
	return id
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func atou(s string, d uint64) uint64 {
	if s == "" {
		return d
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return d
	}
	return v
}
