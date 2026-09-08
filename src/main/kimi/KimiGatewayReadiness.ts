export interface KimiGatewayReceipt {
  generation: number
  initializeResponses: number
  toolsListResponses: number
  toolCalls: number
  toolNames: string[]
  closed: boolean
}

export type KimiRequiredToolGroups = readonly (readonly string[])[]

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function missingKimiToolGroups(
  receipt: KimiGatewayReceipt,
  required: KimiRequiredToolGroups
): string[][] {
  return required
    .filter((group) => !group.some((name) => receipt.toolNames.includes(name)))
    .map((group) => [...group])
}

export function kimiGatewayCatalogueReady(
  receipt: KimiGatewayReceipt,
  required: KimiRequiredToolGroups = []
): boolean {
  return (
    !receipt.closed &&
    receipt.initializeResponses > 0 &&
    receipt.toolsListResponses > 0 &&
    receipt.toolNames.length > 0 &&
    missingKimiToolGroups(receipt, required).length === 0
  )
}

export function createKimiGatewayReadiness() {
  let state: KimiGatewayReceipt = {
    generation: 0,
    initializeResponses: 0,
    toolsListResponses: 0,
    toolCalls: 0,
    toolNames: [],
    closed: false
  }
  const listeners = new Set<(receipt: KimiGatewayReceipt) => void>()
  const snapshot = (): KimiGatewayReceipt => ({ ...state, toolNames: [...state.toolNames] })
  const publish = (): void => {
    for (const listener of listeners) {
      try {
        listener(snapshot())
      } catch {
        // Diagnostic consumers cannot change transport admission or completion.
      }
    }
  }

  return {
    snapshot,
    beginSession(): number {
      state = {
        generation: state.generation + 1,
        initializeResponses: 0,
        toolsListResponses: 0,
        toolCalls: 0,
        toolNames: [],
        closed: state.closed
      }
      publish()
      return state.generation
    },
    responseServed(generation: number, method: unknown, response: unknown): void {
      if (generation !== state.generation || state.closed) return
      const envelope = record(response)
      const result = record(envelope?.result)
      if (!result || envelope?.error !== undefined) return
      if (method === 'initialize' && typeof result.protocolVersion === 'string') {
        state.initializeResponses += 1
      } else if (method === 'tools/list' && Array.isArray(result.tools)) {
        const names = result.tools.map((tool) => record(tool)?.name)
        if (
          names.length > 1_000 ||
          names.some((name) => typeof name !== 'string' || !/^[\w.:-]{1,128}$/.test(name))
        ) {
          return
        }
        state.toolsListResponses += 1
        state.toolNames = [...new Set(names as string[])].sort()
      } else if (method === 'tools/call') {
        state.toolCalls += 1
      } else {
        return
      }
      publish()
    },
    subscribe(listener: (receipt: KimiGatewayReceipt) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitForTools(timeoutMs: number, required: KimiRequiredToolGroups = []): Promise<boolean> {
      const generation = state.generation
      if (kimiGatewayCatalogueReady(state, required)) return Promise.resolve(true)
      if (state.closed) return Promise.resolve(false)
      return new Promise((resolve) => {
        const finish = (ready: boolean): void => {
          clearTimeout(timer)
          listeners.delete(changed)
          resolve(ready)
        }
        const changed = (receipt: KimiGatewayReceipt): void => {
          if (receipt.closed || receipt.generation !== generation) finish(false)
          else if (kimiGatewayCatalogueReady(receipt, required)) finish(true)
        }
        const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
        timer.unref?.()
        listeners.add(changed)
      })
    },
    close(): void {
      state.closed = true
      publish()
      listeners.clear()
    }
  }
}

export type KimiGatewayReadiness = ReturnType<typeof createKimiGatewayReadiness>
