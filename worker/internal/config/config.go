package config

import (
	"errors"
	"os"
	"strconv"
)

type Config struct {
	AttestorID    string
	SrcRPC        string
	DstRPC        string
	SrcEndpoint   string // 0x... source Endpoint (emits PacketSent)
	DstReceiveLib string // 0x... destination ReceiveLib (verify target)
	PrivateKey    string // hex, no 0x
	Confirmations uint64
	PollMs        int
	CursorPath    string
}

func Load() (*Config, error) {
	c := &Config{
		AttestorID:    os.Getenv("ATTESTOR_ID"),
		SrcRPC:        os.Getenv("SRC_RPC"),
		DstRPC:        os.Getenv("DST_RPC"),
		SrcEndpoint:   os.Getenv("SRC_ENDPOINT"),
		DstReceiveLib: os.Getenv("DST_RECEIVE_LIB"),
		PrivateKey:    os.Getenv("ATTESTOR_KEY"),
		CursorPath:    os.Getenv("CURSOR_PATH"),
	}
	c.Confirmations = atou(os.Getenv("CONFIRMATIONS"), 1)
	c.PollMs = int(atou(os.Getenv("POLL_MS"), 200))
	if c.SrcRPC == "" || c.DstRPC == "" || c.PrivateKey == "" || c.SrcEndpoint == "" || c.DstReceiveLib == "" {
		return nil, errors.New("missing required config (SRC_RPC,DST_RPC,SRC_ENDPOINT,DST_RECEIVE_LIB,ATTESTOR_KEY)")
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
