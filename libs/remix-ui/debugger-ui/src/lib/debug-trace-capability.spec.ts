import {
  debugTraceCapabilityForProvider,
  debugTraceCapabilityForTransaction,
  INJECTED_TRONWEB_DEBUG_UNAVAILABLE
} from './debug-trace-capability'

describe('debug trace capability', () => {
  it('explains why Injected TronWeb cannot start step debugging', () => {
    expect(debugTraceCapabilityForProvider('injected')).toEqual({
      supported: false,
      provider: 'injected',
      message: INJECTED_TRONWEB_DEBUG_UNAVAILABLE
    })
    expect(INJECTED_TRONWEB_DEBUG_UNAVAILABLE).toContain('TronLink does not expose transaction VM traces')
  })

  it.each(['vm', 'web3', 'custom', undefined])('keeps the runtime trace probe for %s', (provider) => {
    expect(debugTraceCapabilityForProvider(provider)).toEqual({ supported: true, provider })
  })

  it('explains that a Nile transaction cannot be queried from JavaScript VM', () => {
    const capability = debugTraceCapabilityForTransaction({
      originProvider: 'injected',
      currentProvider: 'vm',
      network: 'TRON/nile'
    })

    expect(capability.supported).toBe(false)
    expect(capability.message).toContain('created on Nile via Injected TronWeb')
    expect(capability.message).toContain('not available in JavaScript VM (Tron)')
    expect(capability.message).toContain('cannot be debugged here or after switching back')
    expect(capability.message).toContain('View it in TronScan')
    expect(capability.message).toContain('reproduce the contract call in JavaScript VM (Tron)')
    expect(capability.message).not.toContain('Switch back to Injected TronWeb')
  })

  it('explains that a reset VM transaction must be rerun after switching environments', () => {
    const capability = debugTraceCapabilityForTransaction({
      originProvider: 'vm',
      currentProvider: 'injected'
    })

    expect(capability.supported).toBe(false)
    expect(capability.message).toContain('created in JavaScript VM (Tron)')
    expect(capability.message).toContain('Switch back to JavaScript VM (Tron)')
    expect(capability.message).toContain('rerun the transaction')
  })

  it('uses the original provider capability when the environment has not changed', () => {
    expect(debugTraceCapabilityForTransaction({
      originProvider: 'injected',
      currentProvider: 'injected',
      network: 'TRON/nile'
    })).toEqual({
      supported: false,
      provider: 'injected',
      message: INJECTED_TRONWEB_DEBUG_UNAVAILABLE
    })
  })
})
