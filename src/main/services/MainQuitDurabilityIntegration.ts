export interface MainQuitDurabilityIntegrationPorts {
  quiesceProducers(): Promise<void>
  saveFinalState(): Promise<void>
  shutdownDurability(): Promise<void>
}

/** Owns ordering only; Electron's bounded quit fallback remains with its coordinator. */
export function createMainQuitDurabilityIntegration(ports: MainQuitDurabilityIntegrationPorts): {
  flush(): Promise<void>
  abandon(): void
} {
  let abandoned = false
  let pending: Promise<void> | undefined
  const assertActive = (): void => {
    if (abandoned) throw new Error('Quit durability drain abandoned before completion.')
  }
  return {
    abandon() {
      abandoned = true
    },
    flush() {
      if (pending) return pending
      pending = (async () => {
        assertActive()
        await ports.quiesceProducers()
        assertActive()
        await ports.saveFinalState()
        // A timed-out quit must not later start descriptor retirement while
        // fallback teardown is already running.
        assertActive()
        await ports.shutdownDurability()
        assertActive()
      })()
      return pending
    }
  }
}
