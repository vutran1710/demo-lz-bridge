import { createRequire } from 'node:module'
import type { Abi, Hex } from 'viem'

// Load forge artifacts at runtime (avoids JSON import-assertion churn across TS/node versions).
const require = createRequire(import.meta.url)
function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const j = require(`../../../contracts/out/${path}`)
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex }
}

export const ABI = {
  Endpoint: artifact('Endpoint.sol/Endpoint.json'),
  SendLib: artifact('SendLib.sol/SendLib.json'),
  ReceiveLib: artifact('ReceiveLib.sol/ReceiveLib.json'),
  AppEcho: artifact('AppEcho.sol/AppEcho.json'),
  AppRevert: artifact('AppRevert.sol/AppRevert.json'),
}
