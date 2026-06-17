// Package status exposes a tiny self-report endpoint (GET /status) so the playground UI can show
// which DVN/Executor instances are online and how many requests each has processed.
package status

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
)

type Reporter struct {
	ID        string
	Role      string // "dvn" | "executor"
	Pathways  int
	processed int64
}

func New(id, role string, pathways int) *Reporter {
	return &Reporter{ID: id, Role: role, Pathways: pathways}
}

// Inc records one processed request (a verify for a DVN, a delivery for the Executor).
func (r *Reporter) Inc() { atomic.AddInt64(&r.processed, 1) }

type snapshot struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Online    bool   `json:"online"`
	Processed int64  `json:"processed"`
	Pathways  int    `json:"pathways"`
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
			ID: r.ID, Role: r.Role, Online: true, Processed: atomic.LoadInt64(&r.processed), Pathways: r.Pathways,
		})
	})
	srv := &http.Server{Addr: addr, Handler: mux}
	go func() { <-ctx.Done(); _ = srv.Close() }()
	go func() { _ = srv.ListenAndServe() }()
}
