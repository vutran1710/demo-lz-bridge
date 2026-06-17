package executor

import (
	"context"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

const readABI = `[
  {"type":"function","name":"verifiable","stateMutability":"view","inputs":[
    {"name":"packetHeader","type":"bytes"},{"name":"payloadHash","type":"bytes32"}],"outputs":[{"name":"","type":"bool"}]},
  {"type":"function","name":"committed","stateMutability":"view","inputs":[
    {"name":"","type":"bytes32"},{"name":"","type":"bytes32"}],"outputs":[{"name":"","type":"bool"}]},
  {"type":"function","name":"inboundPayloadHash","stateMutability":"view","inputs":[
    {"name":"receiver","type":"address"},{"name":"srcEid","type":"uint32"},{"name":"sender","type":"bytes32"},{"name":"nonce","type":"uint64"}],"outputs":[{"name":"","type":"bytes32"}]}
]`

// Reader provides read-only views on the destination ReceiveLib + Endpoint (no signing key).
type Reader struct {
	receiveLib *bind.BoundContract
	endpoint   *bind.BoundContract
}

func NewReader(dst *ethclient.Client, receiveLib, endpoint common.Address) (*Reader, error) {
	parsed, err := abi.JSON(strings.NewReader(readABI))
	if err != nil {
		return nil, err
	}
	return &Reader{
		receiveLib: bind.NewBoundContract(receiveLib, parsed, dst, dst, dst),
		endpoint:   bind.NewBoundContract(endpoint, parsed, dst, dst, dst),
	}, nil
}

func (r *Reader) Verifiable(ctx context.Context, header []byte, payloadHash common.Hash) (bool, error) {
	var out []interface{}
	if err := r.receiveLib.Call(&bind.CallOpts{Context: ctx}, &out, "verifiable", header, [32]byte(payloadHash)); err != nil {
		return false, err
	}
	b, _ := out[0].(bool)
	return b, nil
}

func (r *Reader) Committed(ctx context.Context, headerHash, payloadHash common.Hash) (bool, error) {
	var out []interface{}
	if err := r.receiveLib.Call(&bind.CallOpts{Context: ctx}, &out, "committed", [32]byte(headerHash), [32]byte(payloadHash)); err != nil {
		return false, err
	}
	b, _ := out[0].(bool)
	return b, nil
}

// Delivered reports whether the message has been executed (committed payload hash cleared to zero).
func (r *Reader) Delivered(ctx context.Context, receiver common.Address, srcEid uint32, sender [32]byte, nonce uint64, committedHash common.Hash) (bool, error) {
	var out []interface{}
	if err := r.endpoint.Call(&bind.CallOpts{Context: ctx}, &out, "inboundPayloadHash", receiver, srcEid, sender, nonce); err != nil {
		return false, err
	}
	h, _ := out[0].([32]byte)
	// delivered = was committed (committedHash != 0) and now cleared (h == 0)
	return common.Hash(h) == (common.Hash{}), nil
}
