package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/onematrix/bridge/worker/internal/executor"
)

func main() {
	cfg, err := executor.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; cancel() }()

	log.Printf("executor started id=%s signers=%d src=%s dst=%s", cfg.ID, len(cfg.Keys), cfg.SrcRPC, cfg.DstRPC)
	if err := executor.New(cfg).Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("run: %v", err)
	}
	log.Printf("executor stopped")
}
