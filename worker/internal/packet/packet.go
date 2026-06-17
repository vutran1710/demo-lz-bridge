package packet

import (
	"encoding/binary"
	"errors"

	"github.com/ethereum/go-ethereum/common"
	"golang.org/x/crypto/sha3"
)

// ErrBadPacket indicates a malformed encoded packet.
var ErrBadPacket = errors.New("bad packet")

// Parsed is a decoded PacketSent payload.
//
// Wire format (spec §4): header(81) ‖ guid(32) ‖ message
//
//	0      version (1)
//	1      nonce   (8, big-endian uint64)
//	9      srcEid  (4, big-endian uint32)
//	13     sender  (32)
//	45     dstEid  (4)
//	49     receiver(32)
//	81     guid    (32)
//	113    message (variable)
type Parsed struct {
	Header      []byte
	Guid        common.Hash
	Message     []byte
	PayloadHash common.Hash
	SrcEid      uint32
	Nonce       uint64
}

func keccak(parts ...[]byte) common.Hash {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	var out common.Hash
	copy(out[:], h.Sum(nil))
	return out
}

// Parse decodes an encoded packet and recomputes its payload hash = keccak256(guid ‖ message).
func Parse(encoded []byte) (Parsed, error) {
	if len(encoded) < 113 || encoded[0] != 1 {
		return Parsed{}, ErrBadPacket
	}
	header := encoded[:81]
	guid := common.BytesToHash(encoded[81:113])
	message := encoded[113:]
	return Parsed{
		Header:      header,
		Guid:        guid,
		Message:     message,
		PayloadHash: keccak(guid.Bytes(), message),
		Nonce:       binary.BigEndian.Uint64(header[1:9]),
		SrcEid:      binary.BigEndian.Uint32(header[9:13]),
	}, nil
}
