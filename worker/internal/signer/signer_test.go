package signer

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

func TestFrom_derivesAnvilAccount0(t *testing.T) {
	key, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	auth, err := bind.NewKeyedTransactorWithChainID(key, big.NewInt(31337))
	if err != nil {
		t.Fatalf("auth: %v", err)
	}
	s := &Signer{auth: auth}
	want := common.HexToAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
	if s.From() != want {
		t.Errorf("From() = %s, want %s", s.From().Hex(), want.Hex())
	}
}

func TestReserveNonce_sequenceAndOverride(t *testing.T) {
	s := &Signer{nonce: 5}
	if got := s.reserveNonce(); got != 5 {
		t.Errorf("first reserve = %d, want 5", got)
	}
	if got := s.reserveNonce(); got != 6 {
		t.Errorf("second reserve = %d, want 6", got)
	}
	s.SetNonce(10)
	if got := s.reserveNonce(); got != 10 {
		t.Errorf("after SetNonce reserve = %d, want 10", got)
	}
}
