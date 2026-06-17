package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/onematrix/bridge/worker/internal/attestor"
	"github.com/onematrix/bridge/worker/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; cancel() }()

	log.Printf("attestor started id=%s src=%s dst=%s", cfg.AttestorID, cfg.SrcRPC, cfg.DstRPC)
	if err := attestor.New(cfg).Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("run: %v", err)
	}
	log.Printf("attestor stopped")
}
