package submit

import (
	"context"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const receiveLibABI = `[
  {"type":"function","name":"verify","stateMutability":"nonpayable","inputs":[
    {"name":"packetHeader","type":"bytes"},{"name":"payloadHash","type":"bytes32"},{"name":"confirmations","type":"uint64"}],"outputs":[]},
  {"type":"function","name":"commitVerification","stateMutability":"nonpayable","inputs":[
    {"name":"packetHeader","type":"bytes"},{"name":"payloadHash","type":"bytes32"}],"outputs":[]},
  {"type":"function","name":"committed","stateMutability":"view","inputs":[
    {"name":"","type":"bytes32"},{"name":"","type":"bytes32"}],"outputs":[{"name":"","type":"bool"}]}
]`

// Submitter signs and sends verify/commit transactions to the destination ReceiveLib.
// It manages its own account nonce locally to avoid PendingNonceAt races under burst load.
type Submitter struct {
	auth     *bind.TransactOpts
	contract *bind.BoundContract
	client   *ethclient.Client
	nonce    uint64
}

func New(ctx context.Context, dst *ethclient.Client, receiveLib common.Address, hexKey string) (*Submitter, error) {
	key, err := crypto.HexToECDSA(hexKey)
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
	parsed, err := abi.JSON(strings.NewReader(receiveLibABI))
	if err != nil {
		return nil, err
	}
	contract := bind.NewBoundContract(receiveLib, parsed, dst, dst, dst)
	nonce, err := dst.PendingNonceAt(ctx, auth.From)
	if err != nil {
		return nil, err
	}
	return &Submitter{auth: auth, contract: contract, client: dst, nonce: nonce}, nil
}

// transact sends a method call with an explicit, locally-tracked nonce. On a successful submit the
// nonce is advanced. A pre-send error (e.g. gas estimation revert) leaves the nonce untouched.
func (s *Submitter) transact(ctx context.Context, method string, args ...interface{}) (common.Hash, error) {
	opts := *s.auth
	opts.Context = ctx
	opts.Nonce = new(big.Int).SetUint64(s.nonce)
	tx, err := s.contract.Transact(&opts, method, args...)
	if err == nil {
		s.nonce++
	}
	if err != nil {
		return common.Hash{}, err
	}
	return tx.Hash(), nil
}

// Address returns the attestor signer address.
func (s *Submitter) Address() common.Address { return s.auth.From }

// Verify submits this attestor's verification. Fire-and-forget: Anvil/permissioned chains mine
// promptly, and bind.Transact uses the pending nonce, so sequential sends stay ordered without
// paying bind.WaitMined's 1s poll per tx.
func (s *Submitter) Verify(ctx context.Context, header []byte, payloadHash common.Hash, confirmations uint64) (common.Hash, error) {
	return s.transact(ctx, "verify", header, [32]byte(payloadHash), confirmations)
}

// Commit attempts commitVerification. Transact estimates gas first, so a not-yet-verifiable or
// already-committed packet returns an error here (no tx sent) — caller treats it as opportunistic.
func (s *Submitter) Commit(ctx context.Context, header []byte, payloadHash common.Hash) (common.Hash, error) {
	return s.transact(ctx, "commitVerification", header, [32]byte(payloadHash))
}

// IsCommitted reports whether (headerHash, payloadHash) has been committed on the ReceiveLib.
func (s *Submitter) IsCommitted(ctx context.Context, headerHash, payloadHash common.Hash) (bool, error) {
	var out []interface{}
	err := s.contract.Call(&bind.CallOpts{Context: ctx}, &out, "committed", [32]byte(headerHash), [32]byte(payloadHash))
	if err != nil || len(out) == 0 {
		return false, err
	}
	committed, _ := out[0].(bool)
	return committed, nil
}

// HeaderHash is keccak256(packetHeader) — the key used by the ReceiveLib.
func HeaderHash(header []byte) common.Hash { return crypto.Keccak256Hash(header) }
