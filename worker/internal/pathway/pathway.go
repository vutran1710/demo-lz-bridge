// Package pathway describes the directed bridge pathways a multi-chain worker services.
// A pathway is one A→B route: watch source PacketSent, act on the destination. Multi-chain is
// just a list of these (the on-chain side is already multi-destination via one Endpoint + eid
// registry). Back-compat: with no PATHWAYS_JSON, a single pathway is built from the flat env vars.
package pathway

import (
	"encoding/json"
	"errors"
	"os"
	"strconv"
)

type Pathway struct {
	ID            string `json:"id"`
	SrcRPC        string `json:"srcRpc"`
	DstRPC        string `json:"dstRpc"`
	DstReceiveLib string `json:"dstReceiveLib"`
	DstEndpoint   string `json:"dstEndpoint"` // required by the executor; unused by the attestor
	Confirmations uint64 `json:"confirmations"`
	DstEid        uint32 `json:"dstEid"` // 0 = no filter (single-pathway back-compat); else only handle packets bound here
}

// Load returns the pathway list. If PATHWAYS_JSON is set it is parsed; otherwise a single pathway
// is assembled from SRC_RPC/DST_RPC/DST_RECEIVE_LIB/DST_ENDPOINT/CONFIRMATIONS (single-pathway
// back-compat).
func Load() ([]Pathway, error) {
	if j := os.Getenv("PATHWAYS_JSON"); j != "" {
		var ps []Pathway
		if err := json.Unmarshal([]byte(j), &ps); err != nil {
			return nil, err
		}
		if len(ps) == 0 {
			return nil, errors.New("PATHWAYS_JSON is empty")
		}
		for i := range ps {
			if ps[i].ID == "" {
				ps[i].ID = strconv.Itoa(i)
			}
			if ps[i].Confirmations == 0 {
				ps[i].Confirmations = 1
			}
		}
		return ps, nil
	}
	src, dst := os.Getenv("SRC_RPC"), os.Getenv("DST_RPC")
	if src == "" || dst == "" {
		return nil, errors.New("missing SRC_RPC/DST_RPC (and no PATHWAYS_JSON)")
	}
	conf := uint64(1)
	if v, err := strconv.ParseUint(os.Getenv("CONFIRMATIONS"), 10, 64); err == nil && v > 0 {
		conf = v
	}
	return []Pathway{{
		ID:            "0",
		SrcRPC:        src,
		DstRPC:        dst,
		DstReceiveLib: os.Getenv("DST_RECEIVE_LIB"),
		DstEndpoint:   os.Getenv("DST_ENDPOINT"),
		Confirmations: conf,
	}}, nil
}
