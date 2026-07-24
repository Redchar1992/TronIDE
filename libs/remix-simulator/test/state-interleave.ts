/* global describe, before, it */
// Adversarial interleaving probe: fire eth_call WITHOUT awaiting around
// writes, in patterns mimicking UI/AI concurrency, and check for the poison
// signature: a mined write whose state later vanishes (read returns a stale
// value forever after).
import Web3 from 'web3'
import { Provider } from '../src/index'
import * as assert from 'assert'

describe('adversarial call/write interleave', () => {
  const web3 = new Web3()
  let accounts: string[]
  let inst: any

  const abi: any = [
    { constant: false, inputs: [{ name: 'x', type: 'uint256' }], name: 'set', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' },
    { constant: true, inputs: [], name: 'get', outputs: [{ name: 'retVal', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' },
    { inputs: [{ name: 'initialValue', type: 'uint256' }], payable: false, stateMutability: 'nonpayable', type: 'constructor' }
  ]
  const code = '0x608060405234801561001057600080fd5b506040516020806102018339810180604052602081101561003057600080fd5b810190808051906020019092919050505080600081905550506101a9806100586000396000f3fe60806040526004361061005c576000357c0100000000000000000000000000000000000000000000000000000000900480632a1afcd91461006157806360fe47b11461008c5780636d4ce63c146100c7578063ce01e1ec146100f2575b600080fd5b34801561006d57600080fd5b5061007661012d565b6040518082815260200191505060405180910390f35b34801561009857600080fd5b506100c5600480360360208110156100af57600080fd5b8101908080359060200190929190505050610133565b005b3480156100d357600080fd5b506100dc61013d565b6040518082815260200191505060405180910390f35b3480156100fe57600080fd5b5061012b6004803603602081101561011557600080fd5b8101908080359060200190929190505050610146565b005b60005481565b8060008190555050565b60008054905090565b80600081905550807f63a242a632efe33c0e210e04e4173612a17efa4f16aa4890bc7e46caece80de060405160405180910390a25056fea165627a7a7230582063160eb16dc361092a85ced1a773eed0b63738b83bea1e1c51cf066fa90e135d0029'

  before(async function () {
    this.timeout(60000)
    const provider = new Provider({ fork: 'tron' })
    await provider.init()
    web3.setProvider(provider as any)
    accounts = await web3.eth.getAccounts()
    const c = new web3.eth.Contract(abi)
    inst = await c.deploy({ data: code, arguments: [7] }).send({ from: accounts[0], gas: 400000 })
  })

  it('50 rounds: unawaited reads straddling each write never lose the write', async function () {
    this.timeout(240000)
    const from = accounts[0]
    for (let i = 1; i <= 50; i++) {
      const v = 5000 + i
      // fire a read BEFORE the write without awaiting (straddler #1)
      const r1 = inst.methods.get().call({ from }).catch((e: any) => 'ERR:' + e.message)
      // the write
      const w = inst.methods.set(v).send({ from, gas: 400000 })
      // fire a read immediately after issuing the write, still not awaited
      const r2 = inst.methods.get().call({ from }).catch((e: any) => 'ERR:' + e.message)
      await w
      // read AFTER the write is mined — must ALWAYS be v
      const settled = await inst.methods.get().call({ from })
      const [a, b] = await Promise.all([r1, r2])
      assert.strictEqual(String(settled), String(v),
        `round ${i}: post-write read lost the write (got ${settled}, want ${v}; straddlers=${a},${b})`)
    }
  })

  it('a mined write survives 20 subsequent concurrent reads (no poison)', async function () {
    this.timeout(240000)
    const from = accounts[0]
    await inst.methods.set(31337).send({ from, gas: 400000 })
    const reads = []
    for (let i = 0; i < 20; i++) reads.push(inst.methods.get().call({ from }))
    const all = await Promise.all(reads)
    for (const r of all) assert.strictEqual(String(r), '31337', `concurrent read saw ${r}`)
    const finalV = await inst.methods.get().call({ from })
    assert.strictEqual(String(finalV), '31337', `state poisoned after concurrent reads: ${finalV}`)
  })
})
