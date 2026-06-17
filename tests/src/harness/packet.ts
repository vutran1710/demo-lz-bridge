import { concat, encodePacked, keccak256, pad, type Hex } from 'viem'

// TS mirror of PacketCodec (spec §4). The executable spec for the byte layout.

export function buildGuid(nonce: bigint, srcEid: number, sender: Hex, dstEid: number, receiver: Hex): Hex {
  return keccak256(
    encodePacked(
      ['uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'],
      [nonce, srcEid, pad(sender, { size: 32 }), dstEid, pad(receiver, { size: 32 })],
    ),
  )
}

export function encodeHeader(nonce: bigint, srcEid: number, sender: Hex, dstEid: number, receiver: Hex): Hex {
  return encodePacked(
    ['uint8', 'uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'],
    [1, nonce, srcEid, pad(sender, { size: 32 }), dstEid, pad(receiver, { size: 32 })],
  )
}

export function payloadHashOf(guid: Hex, message: Hex): Hex {
  return keccak256(concat([guid, message]))
}

export function encodePacket(
  nonce: bigint,
  srcEid: number,
  sender: Hex,
  dstEid: number,
  receiver: Hex,
  message: Hex,
) {
  const guid = buildGuid(nonce, srcEid, sender, dstEid, receiver)
  const header = encodeHeader(nonce, srcEid, sender, dstEid, receiver)
  return { guid, header, payloadHash: payloadHashOf(guid, message), encoded: concat([header, guid, message]) }
}
