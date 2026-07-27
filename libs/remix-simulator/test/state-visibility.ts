/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* global describe, before, it */
import Web3 from 'web3'
import { Provider } from '../src/index'
import * as assert from 'assert'

// Same-round write -> read visibility (the write_contract / read_contract
// AI-tool sequence): a state-changing transaction is mined, and an eth_call
// issued IMMEDIATELY from the receipt continuation must observe the committed
// state. TC-VM-002 exercises the same pair through the UI where human-scale
// delays hide timing holes; this pins the tight back-to-back ordering.

describe('same-round write -> read state visibility', () => {
  const web3 = new Web3()
  let accounts: string[]
  let contractInstance: any

  // SimpleStorage: constructor(uint256), set(uint256) [0x60fe47b1],
  // get() view [0x6d4ce63c], storedData() view [0x2a1afcd9] — same artifact
  // the blocks.ts suite deploys.
  const abi: any = [
    { constant: false, inputs: [{ name: 'x', type: 'uint256' }], name: 'set', outputs: [], payable: false, stateMutability: 'nonpayable', type: 'function' },
    { constant: true, inputs: [], name: 'get', outputs: [{ name: 'retVal', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' },
    { constant: true, inputs: [], name: 'storedData', outputs: [{ name: '', type: 'uint256' }], payable: false, stateMutability: 'view', type: 'function' },
    { inputs: [{ name: 'initialValue', type: 'uint256' }], payable: false, stateMutability: 'nonpayable', type: 'constructor' }
  ]
  const code = '0x608060405234801561001057600080fd5b506040516020806102018339810180604052602081101561003057600080fd5b810190808051906020019092919050505080600081905550506101a9806100586000396000f3fe60806040526004361061005c576000357c0100000000000000000000000000000000000000000000000000000000900480632a1afcd91461006157806360fe47b11461008c5780636d4ce63c146100c7578063ce01e1ec146100f2575b600080fd5b34801561006d57600080fd5b5061007661012d565b6040518082815260200191505060405180910390f35b34801561009857600080fd5b506100c5600480360360208110156100af57600080fd5b8101908080359060200190929190505050610133565b005b3480156100d357600080fd5b506100dc61013d565b6040518082815260200191505060405180910390f35b3480156100fe57600080fd5b5061012b6004803603602081101561011557600080fd5b8101908080359060200190929190505050610146565b005b60005481565b8060008190555050565b60008054905090565b80600081905550807f63a242a632efe33c0e210e04e4173612a17efa4f16aa4890bc7e46caece80de060405160405180910390a25056fea165627a7a7230582063160eb16dc361092a85ced1a773eed0b63738b83bea1e1c51cf066fa90e135d0029'

  before(async function () {
    this.timeout(60000)
    const provider = new Provider({ fork: 'tron' })
    await provider.init()
    web3.setProvider(provider as any)
    accounts = await web3.eth.getAccounts()

    const contract = new web3.eth.Contract(abi)
    contractInstance = await contract.deploy({ data: code, arguments: [100] }).send({ from: accounts[0], gas: 400000 })
    contractInstance.currentProvider = web3.eth.currentProvider
    contractInstance.givenProvider = web3.eth.currentProvider
  })

  it('deploy -> immediate read returns the constructor-written value', async function () {
    this.timeout(60000)
    const value = await contractInstance.methods.get().call({ from: accounts[0] })
    assert.strictEqual(String(value), '100')
  })

  it('write then immediate read observes the committed value', async function () {
    this.timeout(60000)
    await contractInstance.methods.set(42).send({ from: accounts[0], gas: 400000 })
    const value = await contractInstance.methods.get().call({ from: accounts[0] })
    assert.strictEqual(String(value), '42')
  })

  it('ten back-to-back write->read rounds each observe their own write', async function () {
    this.timeout(120000)
    for (let i = 1; i <= 10; i++) {
      const expected = 1000 + i
      await contractInstance.methods.set(expected).send({ from: accounts[0], gas: 400000 })
      const value = await contractInstance.methods.get().call({ from: accounts[0] })
      assert.strictEqual(String(value), String(expected), `round ${i}: read after write returned ${value}, expected ${expected}`)
    }
  })

  it('read -> write -> read: the pre-read must not mask the write', async function () {
    this.timeout(60000)
    const before = await contractInstance.methods.get().call({ from: accounts[0] })
    assert.ok(before !== undefined)
    await contractInstance.methods.set(777).send({ from: accounts[0], gas: 400000 })
    const after = await contractInstance.methods.get().call({ from: accounts[0] })
    assert.strictEqual(String(after), '777')
  })
})
