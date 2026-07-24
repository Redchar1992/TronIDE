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
import { ethers } from 'ethers'
import { getFunctionFragment } from './txHelper'

interface NatSpecErrorDoc {
  notice?: string
  params?: Record<string, string>
}

/**
  * deploy the given contract
  *
  * @param {String} from    - sender address
  * @param {String} data    - data to send with the transaction ( return of txFormat.buildData(...) ).
  * @param {String} value    - decimal representation of value.
  * @param {String} gasLimit    - decimal representation of gas limit.
  * @param {Object} txRunner    - TxRunner.js instance
  * @param {Object} callbacks    - { confirmationCb, gasEstimationForceSend, promptCb }
  *     [validate transaction] confirmationCb (network, tx, gasEstimation, continueTxExecution, cancelCb)
  *     [transaction failed, force send] gasEstimationForceSend (error, continueTxExecution, cancelCb)
  *     [personal mode enabled, need password to continue] promptCb (okCb, cancelCb)
  * @param {Function} finalCallback    - last callback.
  */
export function createContract (from, data, value, tokenId, tokenValue, gasLimit, txRunner, callbacks, finalCallback) {
  if (!callbacks.confirmationCb || !callbacks.gasEstimationForceSend || !callbacks.promptCb) {
    return finalCallback('all the callbacks must have been defined')
  }
  const tx = { from: from, to: null, data: data, useCall: false, value: value, tokenId: tokenId, tokenValue: tokenValue, gasLimit: gasLimit }
  txRunner.rawRun(tx, callbacks.confirmationCb, callbacks.gasEstimationForceSend, callbacks.promptCb, (error, txResult) => {
    // see universaldapp.js line 660 => 700 to check possible values of txResult (error case)
    finalCallback(error, txResult)
  })
}

/**
  * call the current given contract ! that will create a transaction !
  *
  * @param {String} from    - sender address
  * @param {String} to    - recipient address
  * @param {String} data    - data to send with the transaction ( return of txFormat.buildData(...) ).
  * @param {String} value    - decimal representation of value.
  * @param {String} gasLimit    - decimal representation of gas limit.
  * @param {Object} txRunner    - TxRunner.js instance
  * @param {Object} callbacks    - { confirmationCb, gasEstimationForceSend, promptCb }
  *     [validate transaction] confirmationCb (network, tx, gasEstimation, continueTxExecution, cancelCb)
  *     [transaction failed, force send] gasEstimationForceSend (error, continueTxExecution, cancelCb)
  *     [personal mode enabled, need password to continue] promptCb (okCb, cancelCb)
  * @param {Function} finalCallback    - last callback.
  */
export function callFunction (from, to, data, value, tokenId, tokenValue, gasLimit, funAbi, txRunner, callbacks, finalCallback) {
  const useCall = funAbi.stateMutability === 'view' || funAbi.stateMutability === 'pure' || funAbi.constant
  const tx = { from, to, data, useCall, value, tokenId, tokenValue, gasLimit, funAbi }
  txRunner.rawRun(tx, callbacks.confirmationCb, callbacks.gasEstimationForceSend, callbacks.promptCb, (error, txResult) => {
    // see universaldapp.js line 660 => 700 to check possible values of txResult (error case)
    finalCallback(error, txResult)
  })
}

/**
  * check if the vm has errored
  *
  * @param {Object} execResult    - execution result given by the VM
  * @return {Object} -  { error: true/false, message: DOMNode }
  */
export function checkVMError (execResult, abi, contract) {
  const errorCode = {
    OUT_OF_GAS: 'out of gas',
    STACK_UNDERFLOW: 'stack underflow',
    STACK_OVERFLOW: 'stack overflow',
    INVALID_JUMP: 'invalid JUMP',
    INVALID_OPCODE: 'invalid opcode',
    REVERT: 'revert',
    STATIC_STATE_CHANGE: 'static state change',
    INTERNAL_ERROR: 'internal error',
    CREATE_COLLISION: 'create collision',
    STOP: 'stop',
    REFUND_EXHAUSTED: 'refund exhausted'
  }
  const ret = {
    error: false,
    message: '',
    // A concise, single-line summary of the revert cause for programmatic
    // callers (the AI write path). `.message` stays the verbose UI text.
    reason: ''
  }
  if (!execResult.exceptionError) {
    return ret
  }
  const exceptionError = execResult.exceptionError.error || ''
  const error = `VM error: ${exceptionError}.\n`
  let msg
  if (exceptionError === errorCode.INVALID_OPCODE) {
    msg = '\t\n\tThe execution might have thrown.\n'
    ret.error = true
    ret.reason = 'invalid opcode (the execution may have thrown)'
  } else if (exceptionError === errorCode.OUT_OF_GAS) {
    msg = '\tThe transaction ran out of gas. Please increase the Gas Limit.\n'
    ret.error = true
    ret.reason = 'out of gas — increase the gas/fee limit'
  } else if (exceptionError === errorCode.REVERT) {
    // The tvmjs VM hands back returnValue as a Uint8Array, not a Buffer, so
    // `.slice(0,4).toString('hex')` produced a comma-joined decimal string —
    // the 4-byte selector never matched and EVERY revert fell through to the
    // generic message (custom errors and require() strings alike were never
    // decoded, in the terminal or the AI path). Normalize to a Buffer first.
    const returnData = execResult.returnValue ? Buffer.from(execResult.returnValue) : Buffer.alloc(0)
    const returnDataHex = returnData.slice(0, 4).toString('hex')
    let customError
    // Now that the Buffer fix makes the 4-byte selector match, the ethers
    // decodes below actually run — and they THROW on a truncated/malformed
    // payload (a hand-rolled `revert` with a real selector but a short tail).
    // This function is called from an unwrapped async waterfall callback
    // (blockchain.js runTx), so an escaping throw would strand the tx as
    // "pending" forever. Contain it and fall back to the generic message.
    try {
      if (abi) {
        let decodedCustomErrorInputsClean
        for (const item of abi) {
          if (item.type === 'error') {
          // ethers doesn't crash anymore if "error" type is specified, but it doesn't extract the errors. see:
          // https://github.com/ethers-io/ethers.js/commit/bd05aed070ac9e1421a3e2bff2ceea150bedf9b7
          // we need here to fake the type, so the "getSighash" function works properly
            const fn = getFunctionFragment({ ...item, type: 'function', stateMutability: 'nonpayable' })
            if (!fn) continue
            const sign = fn.getSighash(item.name)
            if (!sign) continue
            if (returnDataHex === sign.replace('0x', '')) {
              customError = item.name
              const functionDesc = fn.getFunction(item.name)
              // decoding error parameters
              const decodedCustomErrorInputs = fn.decodeFunctionData(functionDesc, returnData)
              decodedCustomErrorInputsClean = {}
              let devdoc: NatSpecErrorDoc = {}
              // "contract" reprensents the compilation result containing the NATSPEC documentation
              if (contract && fn.functions && Object.keys(fn.functions).length) {
                const functionSignature = Object.keys(fn.functions)[0]
                // we check in the 'devdoc' if there's a developer documentation for this error
                try {
                  devdoc = (contract.object.devdoc.errors && contract.object.devdoc.errors[functionSignature][0]) || {}
                } catch (e) {
                  console.error(e.message)
                }
                // we check in the 'userdoc' if there's an user documentation for this error
                try {
                  const userdoc: NatSpecErrorDoc = (contract.object.userdoc.errors && contract.object.userdoc.errors[functionSignature][0]) || {}
                  if (userdoc && userdoc.notice) customError += ' : ' + userdoc.notice // we append the user doc if any
                } catch (e) {
                  console.error(e.message)
                }
              }
              let inputIndex = 0
              for (const input of functionDesc.inputs) {
                const inputKey = input.name || inputIndex
                const v = decodedCustomErrorInputs[inputKey]

                decodedCustomErrorInputsClean[inputKey] = {
                  value: v.toString ? v.toString() : v
                }
                if (devdoc && devdoc.params) {
                  decodedCustomErrorInputsClean[input.name].documentation = devdoc.params[inputKey] // we add the developer documentation for this input parameter if any
                }
                inputIndex++
              }
              break
            }
          }
        }
        if (decodedCustomErrorInputsClean) {
          msg = '\tThe transaction has been reverted to the initial state.\nError provided by the contract:'
          msg += `\n${customError}`
          msg += '\nParameters:'
          msg += `\n${JSON.stringify(decodedCustomErrorInputsClean, null, ' ')}`
          // concise form: Name(k=v, …)
          const argPairs = Object.keys(decodedCustomErrorInputsClean).map((k) => `${k}=${decodedCustomErrorInputsClean[k] && decodedCustomErrorInputsClean[k].value}`)
          ret.reason = `reverted with custom error ${String(customError).split(' : ')[0]}(${argPairs.join(', ')})`
        }
      }
      if (!customError) {
      // It is the hash of Error(string)
        if (returnData && (returnDataHex === '08c379a0')) {
          const abiCoder = new ethers.utils.AbiCoder()
          const reason = abiCoder.decode(['string'], returnData.slice(4))[0]
          msg = `\tThe transaction has been reverted to the initial state.\nReason provided by the contract: "${reason}".`
          ret.reason = `reverted: ${reason}`
        } else if (returnData && (returnDataHex === '4e487b71')) {
        // Panic(uint256) — Solidity 0.8 assert/overflow/array-oob etc.
          const abiCoder = new ethers.utils.AbiCoder()
          const code = abiCoder.decode(['uint256'], returnData.slice(4))[0]
          const hex = '0x' + BigInt(code.toString()).toString(16).padStart(2, '0')
          msg = `\tThe transaction has been reverted to the initial state.\nPanic error ${hex}.`
          ret.reason = `reverted with Panic(${hex})`
        } else {
          msg = '\tThe transaction has been reverted to the initial state.\nNote: The called function should be payable if you send value and the value you send should be less than your current balance.'
          ret.reason = 'reverted (no reason string)'
        }
      }
    } catch (decodeErr) {
      msg = '\tThe transaction has been reverted to the initial state.'
      ret.reason = 'reverted (reason could not be decoded)'
    }
    ret.error = true
  } else if (exceptionError === errorCode.STATIC_STATE_CHANGE) {
    msg = '\tState changes is not allowed in Static Call context\n'
    ret.error = true
  }
  ret.message = `${error}\n${exceptionError}\n${msg}\nDebug the transaction to get more information.`
  return ret
}
