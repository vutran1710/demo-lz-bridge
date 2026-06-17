package chain

import (
	"context"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

const packetSentABI = `[{"type":"event","name":"PacketSent","anonymous":false,"inputs":[
  {"name":"encodedPacket","type":"bytes","indexed":false},
  {"name":"options","type":"bytes","indexed":false},
  {"name":"sendLibrary","type":"address","indexed":false}]}]`

// Clients holds connections to the source (where PacketSent is observed) and destination
// (where verify/commit are submitted) chains.
type Clients struct {
	Src      *ethclient.Client
	Dst      *ethclient.Client
	eventABI abi.ABI
	topic    common.Hash
}

func Dial(srcRPC, dstRPC string) (*Clients, error) {
	src, err := ethclient.Dial(srcRPC)
	if err != nil {
		return nil, err
	}
	dst, err := ethclient.Dial(dstRPC)
	if err != nil {
		return nil, err
	}
	parsed, err := abi.JSON(strings.NewReader(packetSentABI))
	if err != nil {
		return nil, err
	}
	return &Clients{Src: src, Dst: dst, eventABI: parsed, topic: parsed.Events["PacketSent"].ID}, nil
}

func (c *Clients) HeadBlock(ctx context.Context) (uint64, error) {
	return c.Src.BlockNumber(ctx)
}

// FilterPacketSent returns the encodedPacket bytes of every PacketSent log in [from, to] on the
// source chain. Filtered by topic only (the private network has a single PacketSent emitter).
func (c *Clients) FilterPacketSent(ctx context.Context, from, to uint64) ([][]byte, error) {
	logs, err := c.Src.FilterLogs(ctx, ethereum.FilterQuery{
		FromBlock: new(big.Int).SetUint64(from),
		ToBlock:   new(big.Int).SetUint64(to),
		Topics:    [][]common.Hash{{c.topic}},
	})
	if err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(logs))
	for _, l := range logs {
		vals, err := c.eventABI.Unpack("PacketSent", l.Data)
		if err != nil || len(vals) == 0 {
			continue
		}
		if encoded, ok := vals[0].([]byte); ok {
			out = append(out, encoded)
		}
	}
	return out, nil
}
