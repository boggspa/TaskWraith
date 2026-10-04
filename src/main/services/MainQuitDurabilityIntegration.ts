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
        // A producer that cannot be joined must not cost the final save: the
        // last coalesced chat state is still worth writing. Only descriptor
        // retirement is unsafe while a producer may still append.
        let joinFailure: { error: unknown } | undefined
        try {
          await ports.quiesceProducers()
        } catch (error) {
          joinFailure = { error }
        }
        assertActive()
        try {
          await ports.saveFinalState()
        } catch (error) {
          if (!joinFailure) throw error
          throw new AggregateError(
            [joinFailure.error, error],
            'Quit producer join and final save both failed.'
          )
        }
        if (joinFailure) throw joinFailure.error
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
