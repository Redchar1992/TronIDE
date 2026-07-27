/*
 * Original work Copyright © 2018-2021 Remix Team
 * Licensed under the Apache License, Version 2.0.
 *
 * Modifications Copyright © 2022 TronIDE
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

'use strict'
import { BN, bufferToHex } from 'ethereumjs-util'
import { Buffer } from 'buffer'
import * as tvmjsUtil from '@tvmjs/util'
import { EventManager } from '../eventManager'
import { LogsManager } from './logsManager'
import { extractTrc10Balance, parseBigIntValue, parseSafeInteger, TX_FIELD_LABELS, validateTrc10Inputs } from './txIntegerUtils'

const { createLegacyTx, createFeeMarket1559Tx } = require('@tvmjs/tx')
const { createBlock } = require('@tvmjs/block')
const { runBlock, createVM } = require('@tvmjs/vm')
const createAddressFromString = (tvmjsUtil as any).createAddressFromString

function parseVmInteger (rawValue, fieldName) {
  if (typeof rawValue === 'number') {
    return parseSafeInteger(rawValue, 10, fieldName)
  }

  const normalizedValue =
    rawValue === undefined || rawValue === null || rawValue === ''
      ? '0'
      : String(rawValue).trim()

  if (normalizedValue.startsWith('0x') || normalizedValue.startsWith('0X')) {
    return parseSafeInteger(normalizedValue, 16, fieldName)
  }

  return parseSafeInteger(normalizedValue, 10, fieldName)
}

export class TxRunnerVM {
  event
  blockNumber
  runAsync
  pendingTxs
  vmaccounts
  queusTxs
  blocks
  txs
  logsManager
  commonContext
  getVMObject: () => any

  constructor (vmaccounts, api, getVMObject) {
    this.event = new EventManager()
    this.logsManager = new LogsManager()
    // has a default for now for backwards compatability
    this.getVMObject = getVMObject
    this.commonContext = this.getVMObject().common
    this.blockNumber = 0
    this.runAsync = true
    this.blockNumber = 0 // The VM is running in Homestead mode, which started at this block.
    this.runAsync = false // We have to run like this cause the VM Event Manager does not support running multiple txs at the same time.
    this.pendingTxs = {}
    this.vmaccounts = vmaccounts
    this.queusTxs = []
    this.blocks = []
  }

  execute (args, confirmationCb, gasEstimationForceSend, promptCb, callback) {
    let data = args.data
    if (data.slice(0, 2) !== '0x') {
      data = '0x' + data
    }

    try {
      this.runInVm(args.from, args.to, data, args.value, args.tokenId, args.tokenValue, args.gasLimit, args.useCall, args.timestamp, callback)
    } catch (e) {
      callback(e, null)
    }
  }

  runInVm (from, to, data, value, tokenId, tokenValue, gasLimit, useCall, timestamp, callback) {
    const self = this
    const account = self.vmaccounts[from]
    if (!account) {
      return callback('Invalid account selected')
    }

    let normalizedTokenId
    let normalizedTokenValue

    try {
      const normalizedGasLimit = parseVmInteger(gasLimit, TX_FIELD_LABELS.feeLimit)
      // value is a 256-bit wei amount — parse to BigInt without the 2^53-1 cap.
      const normalizedValue = parseBigIntValue(value, TX_FIELD_LABELS.transactionValue)
      normalizedTokenId = parseVmInteger(tokenId, TX_FIELD_LABELS.tokenId)
      normalizedTokenValue = parseVmInteger(tokenValue, TX_FIELD_LABELS.tokenValue)

      const trc10ValidationError = validateTrc10Inputs(normalizedTokenId, normalizedTokenValue)
      if (trc10ValidationError) {
        return callback(trc10ValidationError)
      }

      gasLimit = '0x' + normalizedGasLimit.toString(16)
      value = normalizedValue
      tokenId = normalizedTokenId ? '0x' + normalizedTokenId.toString(16) : '0x0'
      tokenValue = normalizedTokenValue ? '0x' + normalizedTokenValue.toString(16) : '0x0'
    } catch (e) {
      return callback(e.message || String(e))
    }

    this.getVMObject().stateManager.getAccount(createAddressFromString(from)).then((res) => {
      if (normalizedTokenValue > 0) {
        const tokenBalance = extractTrc10Balance(res, normalizedTokenId)
        if (tokenBalance.lt(new BN(normalizedTokenValue))) {
          return callback('No asset')
        }
      }

      const EIP1559 = false
      let tx
      if (!EIP1559) {
        tx = createLegacyTx({
          nonce: res.nonce,
          gasPrice: '0x7',
          gasLimit: gasLimit,
          to: to,
          value: value,
          tokenId: tokenId,
          tokenValue: tokenValue,
          data: Buffer.from(data.slice(2), 'hex')
        }, { common: this.commonContext }).sign(account.privateKey)
      } else {
        tx = createFeeMarket1559Tx({
          nonce: res.nonce,
          maxPriorityFeePerGas: '0x01',
          maxFeePerGas: '0x1',
          gasLimit: gasLimit,
          to: to,
          value: value,
          data: Buffer.from(data.slice(2), 'hex')
        }).sign(account.privateKey)
      }

      const coinbases = ['0x0e9281e9c6a0808672eaba6bd1220e144c9bb07a', '0x8945a1288dc78a6d8952a92c77aee6730b414778', '0x94d76e24f818426ae84aa404140e8d5f60e10e7e']

      var block = createBlock({
        header: {
          timestamp: timestamp || (new Date().getTime() / 1000 | 0),
          number: self.blockNumber,
          coinbase: coinbases[self.blockNumber % coinbases.length],
          gasLimit: BigInt(gasLimit) * BigInt(2),
          baseFeePerGas: EIP1559 ? '0x1' : undefined
        },
        transactions: [tx]
      }, { common: this.commonContext })

      if (!useCall) {
        ++self.blockNumber
        this.runBlockInVm(this.getVMObject().vm, tx, block, callback)
      } else {
        this.runCallInIsolatedVm(tx, block, callback)
      }
    }).catch((e) => {
      callback(e)
    })
  }

  /**
   * Execute a read-only call against an ISOLATED SNAPSHOT of the committed
   * state: a shallow-copied state manager (same backing store, own root
   * pointer and checkpoint stack) bound to a throwaway VM.
   *
   * The previous implementation ran calls on the LIVE VM inside a
   * stateManager.checkpoint()/revert() bracket. That bracket mutates the
   * shared trie's checkpoint stack across many await points; it stays
   * balanced only because the simulator's TxRunner queue serializes every
   * RPC-driven execution. Any caller outside that queue (or a future code
   * path emitting a state commit while a call is in flight) would have its
   * committed state silently rolled back by the call's revert() — the
   * DEF-VM-1 family of storage-drop bugs came from exactly this bracket.
   * Running calls on a snapshot removes the hazard class: a read is
   * structurally unable to move, tear, or roll back live state, whatever
   * the interleaving. It also stops calls from clearing the live
   * _storageTries cache on every revert().
   *
   * Trace events (beforeTx/afterTx/step) are forwarded from the throwaway VM
   * to the live VM's emitters so the debugger/receipt bookkeeping
   * (web3VmProvider) keeps recording calls exactly as before.
   */
  runCallInIsolatedVm (tx, block, callback) {
    const vmObject = this.getVMObject()
    const liveVm = vmObject.vm
    let snapshotSM
    try {
      snapshotSM = vmObject.stateManager.shallowCopy()
    } catch (e) {
      return callback(e)
    }
    createVM({
      common: this.commonContext,
      activatePrecompiles: true,
      stateManager: snapshotSM,
      allowUnlimitedContractSize: true
    }).then((callVm) => {
      const forward = (fromEmitter, toEmitter, topic) => {
        if (!fromEmitter || !toEmitter) return
        fromEmitter.on(topic, (data, next) => {
          const done = () => { if (typeof next === 'function') next() }
          const listeners = typeof toEmitter.listeners === 'function' ? toEmitter.listeners(topic) : []
          ;(async () => {
            for (const listener of listeners) {
              if (listener.length === 2) {
                await new Promise((resolve) => listener(data, resolve))
              } else {
                listener(data)
              }
            }
          })().then(done, done)
        })
      }
      forward(callVm.events, liveVm.events || liveVm, 'beforeTx')
      forward(callVm.events, liveVm.events || liveVm, 'afterTx')
      forward(callVm.tvm && callVm.tvm.events, liveVm.tvm && liveVm.tvm.events, 'step')
      this.runBlockInVm(callVm, tx, block, callback)
    }).catch((err) => {
      callback(err)
    })
  }

  runBlockInVm (vm, tx, block, callback) {
    runBlock(vm, { block: block, generate: true, skipBlockValidation: true, skipBalance: false }).then((results) => {
      const result = results.results[0]
      if (result) {
        const status = result.execResult.exceptionError ? 0 : 1
        result.status = `0x${status}`
      }
      callback(null, {
        result: result,
        transactionHash: bufferToHex(Buffer.from(tx.hash())),
        block,
        tx
      })
    }).catch(function (err) {
      callback(err)
    })
  }
}
