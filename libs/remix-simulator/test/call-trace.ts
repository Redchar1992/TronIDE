/* global describe, before, it */
// The isolated-VM call path must keep feeding the debugger: an eth_call's
// step events are bridged to the live VM's listeners, so debug_traceTransaction
// on the call's tracked hash still returns a populated trace.
import Web3 from 'web3'
import { Provider } from '../src/index'
import * as assert from 'assert'

describe('call tracing through the isolated VM', () => {
  const web3 = new Web3()
  let accounts: string[]
  let addr: string
  let provider: any

  const abi: any = [
    { constant: false, inputs: [{ name: 'x', type: 'uint256' }], name: 'set', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' },
    { constant: true, inputs: [], name: 'get', outputs: [{ name: 'retVal', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' },
    { inputs: [{ name: 'initialValue', type: 'uint256' }], payable: false, stateMutability: 'nonpayable', type: 'constructor' }
  ]
  const code = '0x608060405234801561001057600080fd5b506040516020806102018339810180604052602081101561003057600080fd5b810190808051906020019092919050505080600081905550506101a9806100586000396000f3fe60806040526004361061005c576000357c0100000000000000000000000000000000000000000000000000000000900480632a1afcd91461006157806360fe47b11461008c5780636d4ce63c146100c7578063ce01e1ec146100f2575b600080fd5b34801561006d57600080fd5b5061007661012d565b6040518082815260200191505060405180910390f35b34801561009857600080fd5b506100c5600480360360208110156100af57600080fd5b8101908080359060200190929190505050610133565b005b3480156100d357600080fd5b506100dc61013d565b6040518082815260200191505060405180910390f35b3480156100fe57600080fd5b5061012b6004803603602081101561011557600080fd5b8101908080359060200190929190505050610146565b005b60005481565b8060008190555050565b60008054905090565b80600081905550807f63a242a632efe33c0e210e04e4173612a17efa4f16aa4890bc7e46caece80de060405160405180910390a25056fea165627a7a7230582063160eb16dc361092a85ced1a773eed0b63738b83bea1e1c51cf066fa90e135d0029'

  const rpc = (method: string, params: any[]) => new Promise<any>((resolve, reject) => {
    provider.sendAsync({ id: Date.now(), jsonrpc: '2.0', method, params }, (err: any, res: any) => {
      if (err) return reject(err)
      resolve(res && res.result !== undefined ? res.result : res)
    })
  })

  before(async function () {
    this.timeout(60000)
    provider = new Provider({ fork: 'tron' })
    await provider.init()
    web3.setProvider(provider as any)
    accounts = await web3.eth.getAccounts()
    const c = new web3.eth.Contract(abi)
    const inst: any = await c.deploy({ data: code, arguments: [42] }).send({ from: accounts[0], gas: 400000 })
    addr = inst.options.address
  })

  it('eth_call returns the value AND leaves a debuggable trace under its tag', async function () {
    this.timeout(60000)
    const tag = Date.now()
    // get() selector
    const ret = await rpc('eth_call', [{ from: accounts[0], to: addr, data: '0x6d4ce63c', gas: 3000000, timestamp: tag }])
    assert.ok(String(ret).endsWith('2a'), `eth_call returned ${ret}, want ...2a (42)`)

    const callHash = await rpc('eth_getHashFromTagBySimulator', [tag])
    assert.ok(callHash && callHash.startsWith('0x'), `no tracked hash for the call tag (got ${callHash})`)

    const trace = await rpc('debug_traceTransaction', [callHash, {}])
    assert.ok(trace && Array.isArray(trace.structLogs), 'debug trace missing structLogs')
    assert.ok(trace.structLogs.length > 0, 'call trace is empty — step events were not bridged')
    const ops = trace.structLogs.map((s: any) => s.op)
    assert.ok(ops.includes('SLOAD'), `trace has no SLOAD (ops: ${ops.slice(0, 10).join(',')}...)`)
  })

  it('the call ran isolated: live state root untouched, next write still lands', async function () {
    this.timeout(60000)
    const inst = new web3.eth.Contract(abi, addr)
    await inst.methods.set(1234).send({ from: accounts[0], gas: 400000 })
    const v = await inst.methods.get().call({ from: accounts[0] })
    assert.strictEqual(String(v), '1234')
  })
})
