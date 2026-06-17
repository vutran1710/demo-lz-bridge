package packet

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"golang.org/x/crypto/sha3"
)

func buildEncoded(nonce uint64, srcEid uint32, guid common.Hash, message []byte) []byte {
	var b bytes.Buffer
	b.WriteByte(1) // version
	tmp8 := make([]byte, 8)
	binary.BigEndian.PutUint64(tmp8, nonce)
	b.Write(tmp8)
	tmp4 := make([]byte, 4)
	binary.BigEndian.PutUint32(tmp4, srcEid)
	b.Write(tmp4)
	b.Write(make([]byte, 32)) // sender
	binary.BigEndian.PutUint32(tmp4, 2)
	b.Write(tmp4)             // dstEid
	b.Write(make([]byte, 32)) // receiver
	b.Write(guid.Bytes())     // guid
	b.Write(message)
	return b.Bytes()
}

func TestParse_fieldsAndPayloadHash(t *testing.T) {
	guid := common.HexToHash("0x1234")
	message := []byte{0xaa, 0xbb, 0xcc}
	encoded := buildEncoded(7, 42, guid, message)

	p, err := Parse(encoded)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if p.Nonce != 7 {
		t.Errorf("nonce = %d, want 7", p.Nonce)
	}
	if p.SrcEid != 42 {
		t.Errorf("srcEid = %d, want 42", p.SrcEid)
	}
	if !bytes.Equal(p.Message, message) {
		t.Errorf("message mismatch")
	}

	// payloadHash must equal keccak256(guid ‖ message) — must match Solidity/TS
	h := sha3.NewLegacyKeccak256()
	h.Write(guid.Bytes())
	h.Write(message)
	var want common.Hash
	copy(want[:], h.Sum(nil))
	if p.PayloadHash != want {
		t.Errorf("payloadHash = %s, want %s", p.PayloadHash.Hex(), want.Hex())
	}
}

func TestParse_rejectsShortOrBadVersion(t *testing.T) {
	if _, err := Parse(make([]byte, 50)); err == nil {
		t.Error("expected error for short packet")
	}
	bad := buildEncoded(1, 1, common.Hash{}, []byte{1})
	bad[0] = 2 // wrong version
	if _, err := Parse(bad); err == nil {
		t.Error("expected error for bad version")
	}
}
