package config

import (
	"errors"
	"os"
	"strconv"
)

// Config holds the attestor's pathway-independent settings. Routing (which chains/pathways) comes
// from the pathway package (PATHWAYS_JSON, or the flat SRC_RPC/DST_RPC/... single-pathway fallback).
type Config struct {
	AttestorID string
	PrivateKey string // one DVN identity, used to verify on every destination chain
	PollMs     int
	CursorPath string
	StatusAddr string // optional host:port for the /status endpoint
}

func Load() (*Config, error) {
	c := &Config{
		AttestorID: os.Getenv("ATTESTOR_ID"),
		PrivateKey: os.Getenv("ATTESTOR_KEY"),
		PollMs:     int(atou(os.Getenv("POLL_MS"), 200)),
		CursorPath: os.Getenv("CURSOR_PATH"),
		StatusAddr: os.Getenv("STATUS_ADDR"),
	}
	if c.PrivateKey == "" {
		return nil, errors.New("missing ATTESTOR_KEY")
	}
	if c.CursorPath == "" {
		c.CursorPath = "/tmp/attestor-" + c.AttestorID + ".cursor"
	}
	return c, nil
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
