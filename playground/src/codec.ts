import { concat, encodePacked, keccak256, pad, slice, type Hex } from 'viem'

// Mirror of the on-chain PacketCodec (header 81 ‖ guid 32 ‖ message).
export function buildGuid(nonce: bigint, srcEid: number, sender: Hex, dstEid: number, receiver: Hex): Hex {
  return keccak256(
    encodePacked(
      ['uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'],
      [nonce, srcEid, pad(sender, { size: 32 }), dstEid, pad(receiver, { size: 32 })],
    ),
  )
}

// Decode a PacketSent encodedPacket into its parts.
export function decodePacket(encoded: Hex) {
  const header = slice(encoded, 0, 81)
  const guid = slice(encoded, 81, 113)
  const message = slice(encoded, 113)
  const payloadHash = keccak256(slice(encoded, 81)) // keccak(guid ‖ message)
  const headerHash = keccak256(header)
  // header: [0]=ver, [1..9)=nonce, [9..13)=srcEid, [13..45)=sender, [45..49)=dstEid, [49..81)=receiver
  const nonce = BigInt(slice(header, 1, 9))
  return { header, headerHash, guid, message, payloadHash, nonce }
}

export { concat, pad }
