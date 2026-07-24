/*
 * Original work Copyright © 2018-2021 Remix Team
 * Licensed under the MIT License.
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

export interface DebugTraceCapability {
  supported: boolean
  provider?: string
  message?: string
}

export interface TransactionDebugContext {
  originProvider?: string
  currentProvider?: string
  network?: string
}

export const INJECTED_TRONWEB_DEBUG_UNAVAILABLE =
  'Step debugging is unavailable for Injected TronWeb because TronLink does not expose transaction VM traces. Use JavaScript VM (Tron), or connect to a TRON node that supports debug_traceTransaction.'

/**
 * Injected TronWeb can fetch transactions and receipts, but TronLink's public
 * node bridge does not expose the opcode trace required by the debugger.
 * Other providers retain the existing runtime probe because a custom node may
 * implement debug_traceTransaction.
 */
export const debugTraceCapabilityForProvider = (provider?: string): DebugTraceCapability => {
  if (provider === 'injected') {
    return {
      supported: false,
      provider,
      message: INJECTED_TRONWEB_DEBUG_UNAVAILABLE
    }
  }

  return { supported: true, provider }
}

const providerLabel = (provider?: string) => {
  if (provider === 'vm') return 'JavaScript VM (Tron)'
  if (provider === 'injected') return 'Injected TronWeb'
  return provider || 'the original environment'
}

const networkLabel = (network?: string) => {
  if (!network) return null
  const id = network.split('/').pop()?.toLowerCase()
  if (id === 'main' || id === 'mainnet') return 'Mainnet'
  if (id === 'nile') return 'Nile'
  if (id === 'shasta') return 'Shasta'
  return network === 'TRON' ? null : network
}

/**
 * Terminal entries retain the environment in which they were created. Use it
 * before consulting the currently selected provider so an on-chain Nile hash
 * is never looked up in the unrelated in-memory JavaScript VM.
 */
export const debugTraceCapabilityForTransaction = ({
  originProvider,
  currentProvider,
  network
}: TransactionDebugContext): DebugTraceCapability => {
  if (originProvider && currentProvider && originProvider !== currentProvider) {
    const originNetwork = networkLabel(network)
    const origin = originProvider === 'injected' && originNetwork
      ? `on ${originNetwork} via Injected TronWeb`
      : `in ${providerLabel(originProvider)}`
    const current = providerLabel(currentProvider)

    if (originProvider === 'injected') {
      return {
        supported: false,
        provider: originProvider,
        message: `This transaction was created ${origin} and is not available in ${current}. TronLink does not expose the VM trace required for step debugging, so this transaction cannot be debugged here or after switching back. View it in TronScan, or reproduce the contract call in JavaScript VM (Tron) to debug it.`
      }
    }

    const vmResetHint = originProvider === 'vm'
      ? ' If the JavaScript VM was reset or the page was reloaded, rerun the transaction.'
      : ''

    return {
      supported: false,
      provider: originProvider,
      message: `This transaction was created ${origin}, but the current environment is ${current}. ${current} is a separate execution environment and cannot retrieve or debug this transaction. Switch back to ${providerLabel(originProvider)}${originNetwork ? ` on ${originNetwork}` : ''} to inspect it.${vmResetHint}`
    }
  }

  return debugTraceCapabilityForProvider(originProvider || currentProvider)
}
