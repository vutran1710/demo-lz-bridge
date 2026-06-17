package signer

import (
	"context"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const abiJSON = `[
  {"type":"function","name":"commitVerification","stateMutability":"nonpayable","inputs":[
    {"name":"packetHeader","type":"bytes"},{"name":"payloadHash","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"lzReceive","stateMutability":"payable","inputs":[
    {"name":"o","type":"tuple","components":[{"name":"srcEid","type":"uint32"},{"name":"sender","type":"bytes32"},{"name":"nonce","type":"uint64"}]},
    {"name":"receiver","type":"address"},{"name":"guid","type":"bytes32"},{"name":"message","type":"bytes"},{"name":"extraData","type":"bytes"}],"outputs":[]}
]`

// Origin mirrors the on-chain Origin struct for lzReceive.
type Origin struct {
	SrcEid uint32
	Sender [32]byte
	Nonce  uint64
}

// Signer is one funded account on one destination chain. It manages its own nonce locally so
// sequential sends never collide (no PendingNonceAt races under burst).
type Signer struct {
	id     string
	auth   *bind.TransactOpts
	parsed abi.ABI
	client *ethclient.Client

	mu    sync.Mutex
	nonce uint64
}

// New builds a signer bound to a destination chain. id is a stable label (e.g. "dst2#0").
func New(ctx context.Context, id string, dst *ethclient.Client, hexKey string) (*Signer, error) {
	key, err := crypto.HexToECDSA(strings.TrimPrefix(hexKey, "0x"))
	if err != nil {
		return nil, err
	}
	chainID, err := dst.ChainID(ctx)
	if err != nil {
		return nil, err
	}
	auth, err := bind.NewKeyedTransactorWithChainID(key, chainID)
	if err != nil {
		return nil, err
	}
	parsed, err := abi.JSON(strings.NewReader(abiJSON))
	if err != nil {
		return nil, err
	}
	n, err := dst.PendingNonceAt(ctx, auth.From)
	if err != nil {
		return nil, err
	}
	return &Signer{id: id, auth: auth, parsed: parsed, client: dst, nonce: n}, nil
}

func (s *Signer) ID() string           { return s.id }
func (s *Signer) From() common.Address { return s.auth.From }

// reserveNonce returns the current nonce and advances the counter.
func (s *Signer) reserveNonce() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.nonce
	s.nonce++
	return n
}

// SetNonce overrides the local nonce counter (used by tests and on resync).
func (s *Signer) SetNonce(n uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nonce = n
}

func (s *Signer) transact(ctx context.Context, to common.Address, method string, args ...interface{}) (common.Hash, error) {
	c := bind.NewBoundContract(to, s.parsed, s.client, s.client, s.client)
	opts := *s.auth
	opts.Context = ctx
	n := s.reserveNonce()
	opts.Nonce = new(big.Int).SetUint64(n)
	tx, err := c.Transact(&opts, method, args...)
	if err != nil {
		// roll the counter back so the reserved nonce is reused (the tx was never sent)
		s.mu.Lock()
		if s.nonce == n+1 {
			s.nonce = n
		}
		s.mu.Unlock()
		return common.Hash{}, err
	}
	return tx.Hash(), nil
}

// Commit calls ReceiveLib.commitVerification.
func (s *Signer) Commit(ctx context.Context, receiveLib common.Address, header []byte, payloadHash common.Hash) (common.Hash, error) {
	return s.transact(ctx, receiveLib, "commitVerification", header, [32]byte(payloadHash))
}

// Execute calls Endpoint.lzReceive (delivery).
func (s *Signer) Execute(ctx context.Context, endpoint common.Address, o Origin, receiver common.Address, guid common.Hash, message []byte) (common.Hash, error) {
	return s.transact(ctx, endpoint, "lzReceive", o, receiver, [32]byte(guid), message, []byte{})
}
