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

import tape from 'tape'
import { ethers } from 'ethers'
import * as txExecution from '../src/execution/txExecution'

const { checkVMError } = txExecution
const coder = new ethers.utils.AbiCoder()

// Build the 4-byte selector of an error/function signature the same way solc does.
function selector (sig: string): Buffer {
  return Buffer.from(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(sig)).slice(2, 10), 'hex')
}

tape('txExecution.checkVMError revert decoding', (t) => {
  t.test('Error(string) reason → concise .reason', (st) => {
    const data = Buffer.concat([selector('Error(string)'), Buffer.from(coder.encode(['string'], ['insufficient balance']).slice(2), 'hex')])
    const res = checkVMError({ exceptionError: { error: 'revert' }, returnValue: data }, [], null)
    st.equal(res.error, true)
    st.equal(res.reason, 'reverted: insufficient balance')
    st.ok(/insufficient balance/.test(res.message))
    st.end()
  })

  t.test('custom error name + args decoded from the ABI', (st) => {
    const abi = [{ type: 'error', name: 'ReceiverRejected', inputs: [{ name: 'who', type: 'address' }, { name: 'amount', type: 'uint256' }] }]
    const who = '0x1111111111111111111111111111111111111111'
    const data = Buffer.concat([selector('ReceiverRejected(address,uint256)'), Buffer.from(coder.encode(['address', 'uint256'], [who, 42]).slice(2), 'hex')])
    const res = checkVMError({ exceptionError: { error: 'revert' }, returnValue: data }, abi, null)
    st.equal(res.error, true)
    st.ok(res.reason.indexOf('ReceiverRejected') !== -1, 'reason names the custom error')
    st.ok(res.reason.indexOf('42') !== -1, 'reason includes the uint arg')
    st.ok(res.reason.toLowerCase().indexOf(who.slice(2).toLowerCase()) !== -1 || res.reason.indexOf(who) !== -1, 'reason includes the address arg')
    st.end()
  })

  t.test('Panic(uint256) decoded to its code', (st) => {
    const data = Buffer.concat([selector('Panic(uint256)'), Buffer.from(coder.encode(['uint256'], [0x11]).slice(2), 'hex')])
    const res = checkVMError({ exceptionError: { error: 'revert' }, returnValue: data }, [], null)
    st.equal(res.error, true)
    st.equal(res.reason, 'reverted with Panic(0x11)')
    st.end()
  })

  t.test('Uint8Array returnValue decodes too (tvmjs VM shape, not a Buffer)', (st) => {
    // the VM delivers returnValue as a Uint8Array — the selector math must not
    // silently degrade to the generic message (the real J-012 bug).
    const buf = Buffer.concat([selector('Error(string)'), Buffer.from(coder.encode(['string'], ['no funds']).slice(2), 'hex')])
    const asU8 = new Uint8Array(buf)
    const res = checkVMError({ exceptionError: { error: 'revert' }, returnValue: asU8 }, [], null)
    st.equal(res.reason, 'reverted: no funds')
    st.end()
  })

  t.test('malformed revert payload does not throw (contained → generic reason)', (st) => {
    // a real Error(string) selector with a TRUNCATED tail: ethers' decode
    // throws "buffer overrun". checkVMError must contain it, not propagate
    // (an escaping throw hangs the unwrapped tx-completion callback).
    const data = Buffer.concat([selector('Error(string)'), Buffer.from('00', 'hex')])
    let res
    st.doesNotThrow(() => { res = checkVMError({ exceptionError: { error: 'revert' }, returnValue: new Uint8Array(data) }, [], null) })
    st.equal(res.error, true)
    st.equal(res.reason, 'reverted (reason could not be decoded)')
    st.end()
  })

  t.test('revert with no data → generic no-reason', (st) => {
    const res = checkVMError({ exceptionError: { error: 'revert' }, returnValue: Buffer.alloc(0) }, [], null)
    st.equal(res.error, true)
    st.equal(res.reason, 'reverted (no reason string)')
    st.end()
  })

  t.test('out of gas → actionable reason', (st) => {
    const res = checkVMError({ exceptionError: { error: 'out of gas' }, returnValue: Buffer.alloc(0) }, [], null)
    st.equal(res.error, true)
    st.ok(/gas/.test(res.reason))
    st.end()
  })

  t.test('no exceptionError → not an error', (st) => {
    const res = checkVMError({ returnValue: Buffer.alloc(0) }, [], null)
    st.equal(res.error, false)
    st.equal(res.reason, '')
    st.end()
  })

  t.end()
})
