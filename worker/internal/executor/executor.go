package executor

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/onematrix/bridge/worker/internal/chain"
	"github.com/onematrix/bridge/worker/internal/packet"
	"github.com/onematrix/bridge/worker/internal/signer"
)

type Config struct {
	ID            string
	SrcRPC        string
	DstRPC        string
	DstReceiveLib common.Address
	DstEndpoint   common.Address
	Keys          []string // signer pool (hex, with or without 0x)
	Confirmations uint64
	PollMs        int
}

func Load() (*Config, error) {
	c := &Config{
		ID:            envOr("EXECUTOR_ID", "exec"),
		SrcRPC:        os.Getenv("SRC_RPC"),
		DstRPC:        os.Getenv("DST_RPC"),
		DstReceiveLib: common.HexToAddress(os.Getenv("DST_RECEIVE_LIB")),
		DstEndpoint:   common.HexToAddress(os.Getenv("DST_ENDPOINT")),
		Confirmations: atou(os.Getenv("CONFIRMATIONS"), 1),
		PollMs:        int(atou(os.Getenv("POLL_MS"), 100)),
	}
	for _, k := range strings.Split(os.Getenv("EXECUTOR_KEYS"), ",") {
		if s := strings.TrimSpace(k); s != "" {
			c.Keys = append(c.Keys, s)
		}
	}
	if c.SrcRPC == "" || c.DstRPC == "" || len(c.Keys) == 0 || os.Getenv("DST_RECEIVE_LIB") == "" || os.Getenv("DST_ENDPOINT") == "" {
		return nil, errors.New("missing config (SRC_RPC,DST_RPC,DST_RECEIVE_LIB,DST_ENDPOINT,EXECUTOR_KEYS)")
	}
	return c, nil
}

type Executor struct {
	cfg     *Config
	clients *chain.Clients
	reader  *Reader
	sched   *Scheduler
	pool    *Pool
	signers map[string]*signer.Signer
	running map[string]bool
	mu      sync.Mutex
}

func New(cfg *Config) *Executor { return &Executor{cfg: cfg} }

func (e *Executor) Run(ctx context.Context) error {
	clients, err := chain.Dial(e.cfg.SrcRPC, e.cfg.DstRPC)
	if err != nil {
		return err
	}
	reader, err := NewReader(clients.Dst, e.cfg.DstReceiveLib, e.cfg.DstEndpoint)
	if err != nil {
		return err
	}
	e.clients = clients
	e.reader = reader
	e.sched = NewScheduler()
	e.signers = map[string]*signer.Signer{}
	e.running = map[string]bool{}
	ids := []string{}
	for i, k := range e.cfg.Keys {
		id := fmt.Sprintf("%s#%d", e.cfg.ID, i)
		s, err := signer.New(ctx, id, clients.Dst, k)
		if err != nil {
			return err
		}
		e.signers[id] = s
		ids = append(ids, id)
	}
	e.pool = NewPool(ids)

	go e.watch(ctx)
	e.manage(ctx)
	return nil
}

// watch fills the scheduler from source PacketSent events.
func (e *Executor) watch(ctx context.Context) {
	var last uint64
	t := time.NewTicker(time.Duration(e.cfg.PollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			head, err := e.clients.HeadBlock(ctx)
			if err != nil || head+1 < e.cfg.Confirmations {
				continue
			}
			safe := head + 1 - e.cfg.Confirmations
			if safe <= last {
				continue
			}
			logs, err := e.clients.FilterPacketSent(ctx, last+1, safe)
			if err != nil {
				continue
			}
			for _, enc := range logs {
				p, perr := packet.Parse(enc)
				if perr != nil {
					continue
				}
				e.sched.Add(channelKey(p), Item{
					Header: p.Header, Guid: p.Guid, Message: p.Message,
					PayloadHash: p.PayloadHash, Nonce: p.Nonce,
				})
			}
			last = safe
		}
	}
}

// manage spawns one worker goroutine per active channel.
func (e *Executor) manage(ctx context.Context) {
	t := time.NewTicker(time.Duration(e.cfg.PollMs) * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, ch := range e.sched.Channels() {
				e.mu.Lock()
				if !e.running[ch] {
					e.running[ch] = true
					go e.worker(ctx, ch)
				}
				e.mu.Unlock()
			}
		}
	}
}

var errRetry = errors.New("retry")

func (e *Executor) worker(ctx context.Context, channel string) {
	backoff := time.Duration(e.cfg.PollMs) * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}
		it, ok := e.sched.Ready(channel)
		if !ok {
			time.Sleep(backoff)
			continue
		}
		id, ok := e.pool.Lease(channel)
		if !ok {
			time.Sleep(backoff)
			continue
		}
		if err := e.deliver(ctx, e.signers[id], channel, it); err != nil {
			time.Sleep(backoff)
			continue
		}
		e.sched.Done(channel, it.Nonce)
	}
}

// deliver advances one message: commit (if needed, gap-free) then execute. Returns errRetry until done.
func (e *Executor) deliver(ctx context.Context, sgn *signer.Signer, channel string, it Item) error {
	headerHash := crypto.Keccak256Hash(it.Header)
	committed, err := e.reader.Committed(ctx, headerHash, it.PayloadHash)
	if err != nil {
		return err
	}
	if !committed {
		v, err := e.reader.Verifiable(ctx, it.Header, it.PayloadHash)
		if err != nil || !v {
			return errRetry // threshold not met yet
		}
		if err := sgn.Commit(ctx, e.cfg.DstReceiveLib, it.Header, common.Hash(it.PayloadHash)); err != nil {
			return errRetry
		}
		if !e.poll(ctx, func() bool { c, _ := e.reader.Committed(ctx, headerHash, it.PayloadHash); return c }) {
			return errRetry
		}
	}
	// execute (lzReceive). bind estimates gas first, so a reverting receiver errors here (parked).
	srcEid, sender := decodeChannel(channel)
	o := signer.Origin{SrcEid: srcEid, Sender: sender, Nonce: it.Nonce}
	receiver := channelReceiver(channel)
	if err := sgn.Execute(ctx, e.cfg.DstEndpoint, o, receiver, common.Hash(it.Guid), it.Message); err != nil {
		return errRetry // receiver reverted / not yet executable → stays parked
	}
	if !e.poll(ctx, func() bool {
		d, _ := e.reader.Delivered(ctx, receiver, srcEid, sender, it.Nonce, common.Hash(it.PayloadHash))
		return d
	}) {
		return errRetry
	}
	return nil
}

func (e *Executor) poll(ctx context.Context, cond func() bool) bool {
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

// channelKey encodes srcEid, sender (bytes32 hex) and receiver into a stable string.
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

var _ = log.Printf
