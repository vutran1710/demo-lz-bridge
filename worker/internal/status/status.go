// Package status exposes a tiny self-report endpoint (GET /status) so the playground UI can show
// which DVN/Executor instances are online and how many requests each has processed.
package status

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const maxEvents = 256

type Event struct {
	Seq             int64  `json:"seq"`
	Timestamp       int64  `json:"timestamp"`
	WorkerID        string `json:"workerId"`
	Role            string `json:"role"`
	Pathway         string `json:"pathway,omitempty"`
	Action          string `json:"action"`
	Status          string `json:"status"`
	Contract        string `json:"contract,omitempty"`
	ContractAddress string `json:"contractAddress,omitempty"`
	Method          string `json:"method,omitempty"`
	TxHash          string `json:"txHash,omitempty"`
	Guid            string `json:"guid,omitempty"`
	Nonce           uint64 `json:"nonce,omitempty"`
	SrcEid          uint32 `json:"srcEid,omitempty"`
	DstEid          uint32 `json:"dstEid,omitempty"`
	Sender          string `json:"sender,omitempty"`
	Receiver        string `json:"receiver,omitempty"`
	PayloadHash     string `json:"payloadHash,omitempty"`
	Detail          string `json:"detail,omitempty"`
	Error           string `json:"error,omitempty"`
}

type Reporter struct {
	ID        string
	Role      string // "dvn" | "executor"
	Pathways  int
	processed int64
	seq       int64

	mu     sync.Mutex
	events []Event
}

func New(id, role string, pathways int) *Reporter {
	return &Reporter{ID: id, Role: role, Pathways: pathways}
}

// Inc records one processed request (a verify for a DVN, a delivery for the Executor).
func (r *Reporter) Inc() { atomic.AddInt64(&r.processed, 1) }

func (r *Reporter) Event(e Event) {
	e.Seq = atomic.AddInt64(&r.seq, 1)
	e.Timestamp = time.Now().Unix()
	e.WorkerID = r.ID
	e.Role = r.Role

	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
	if len(r.events) > maxEvents {
		r.events = append([]Event(nil), r.events[len(r.events)-maxEvents:]...)
	}
}

func (r *Reporter) recentEvents() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Event, len(r.events))
	copy(out, r.events)
	return out
}

type snapshot struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Online    bool   `json:"online"`
	Processed int64  `json:"processed"`
	Pathways  int    `json:"pathways"`
	Events    []Event `json:"events"`
}

// Serve starts the status HTTP server on addr (e.g. 127.0.0.1:9101). No-op if addr is empty.
func (r *Reporter) Serve(ctx context.Context, addr string) {
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_ = json.NewEncoder(w).Encode(snapshot{
			ID: r.ID, Role: r.Role, Online: true, Processed: atomic.LoadInt64(&r.processed), Pathways: r.Pathways, Events: r.recentEvents(),
		})
	})
	srv := &http.Server{Addr: addr, Handler: mux}
	go func() { <-ctx.Done(); _ = srv.Close() }()
	go func() { _ = srv.ListenAndServe() }()
}
