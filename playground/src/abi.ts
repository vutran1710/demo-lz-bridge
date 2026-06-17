// Minimal ABIs the playground needs.
export const userAppAbi = [
  { type: 'function', name: 'sendMessage', stateMutability: 'payable', inputs: [{ name: 'dstEid', type: 'uint32' }, { name: 'payload', type: 'bytes' }], outputs: [] },
  {
    type: 'event', name: 'Received', inputs: [
      { name: 'srcEid', type: 'uint32', indexed: false },
      { name: 'nonce', type: 'uint64', indexed: false },
      { name: 'sender', type: 'bytes32', indexed: false },
      { name: 'message', type: 'bytes', indexed: false },
    ],
  },
] as const

export const sendLibAbi = [
  {
    type: 'event', name: 'PacketSent', inputs: [
      { name: 'encodedPacket', type: 'bytes', indexed: false },
      { name: 'options', type: 'bytes', indexed: false },
      { name: 'sendLibrary', type: 'address', indexed: false },
    ],
  },
] as const

export const receiveLibAbi = [
  { type: 'function', name: 'committed', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }, { name: '', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }] },
] as const
