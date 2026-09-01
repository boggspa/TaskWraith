/**
 * Host ACP session configuration after session/new or session/resume.
 *
 * Kimi, Grok and Mistral advertise model/thinking/mode on the session result.
 * Passing the same values as session/new `configOptions` is not authoritative:
 * current ACP runtimes ignore that field and keep workspace-last or default
 * model until `session/set_config_option` runs. Desktop AcpTurnClient already
 * drains advertised options this way; the Host adapters must too.
 *
 * This module is Node-safe and MUST NOT import from src/main/** or src/renderer/**.
 */

export interface HostAcpAdvertisedConfigOption {
  readonly id: string
  readonly currentValue?: string
  readonly values: readonly string[]
}

export interface HostAcpSessionConfigSelection {
  readonly configId: string
  readonly values: readonly string[]
  /** Alternate advertised ids, tried in order after `configId`. */
  readonly alternateIds?: readonly string[]
}

export interface HostAcpSessionConfigApplicator {
  begin(input: {
    sessionId: string
    result: unknown
    selections: readonly HostAcpSessionConfigSelection[]
  }): void
  acceptFrame(frame: Record<string, unknown>): boolean
}

const FIRST_CONFIG_RPC_ID = 1000

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() && value.trim() === value ? value.trim() : ''
}

export function readHostAcpAdvertisedConfigOptions(
  result: unknown
): HostAcpAdvertisedConfigOption[] {
  const raw = record(result)?.configOptions
  if (!Array.isArray(raw)) return []
  const out: HostAcpAdvertisedConfigOption[] = []
  for (const entry of raw) {
    const item = record(entry)
    const id = nonEmptyString(item?.id)
    if (!id) continue
    const values = Array.isArray(item?.options)
      ? item.options.map((option) => nonEmptyString(record(option)?.value)).filter(Boolean)
      : []
    const currentValue = nonEmptyString(item?.currentValue)
    out.push({
      id,
      values,
      ...(currentValue ? { currentValue } : {})
    })
  }
  return out
}

export function hostAcpModelAndEffortSelections(input: {
  modelValue: string
  reasoningId?: string
}): HostAcpSessionConfigSelection[] {
  const modelValue = nonEmptyString(input.modelValue)
  const reasoningId = nonEmptyString(input.reasoningId)
  return [
    ...(modelValue ? [{ configId: 'model', values: [modelValue] }] : []),
    ...(reasoningId
      ? [{ configId: 'thinking', values: [reasoningId], alternateIds: ['reasoning'] }]
      : [])
  ]
}

function advertisedForSelection(
  advertised: readonly HostAcpAdvertisedConfigOption[],
  selection: HostAcpSessionConfigSelection
): HostAcpAdvertisedConfigOption | undefined {
  const ids = [selection.configId, ...(selection.alternateIds ?? [])]
  for (const id of ids) {
    const found = advertised.find((option) => option.id === id)
    if (found) return found
  }
  return undefined
}

export function createHostAcpSessionConfigApplicator(options: {
  write: (id: number, method: string, params: Record<string, unknown>) => void
  onWarning: (text: string) => void
  onComplete: () => void
  firstRpcId?: number
  /**
   * Selections that must abort the drain (no prompt) when the advertised
   * config surface exists but cannot honor them — running on whatever value
   * the CLI last persisted would silently contradict the user's selection.
   * A session that advertises no config surface at all keeps today's
   * prompt-anyway behavior.
   */
  strictConfigIds?: readonly string[]
  onStrictUnapplied?: (configId: string, detail: string) => void
}): HostAcpSessionConfigApplicator {
  let sessionId = ''
  let queue: HostAcpSessionConfigSelection[] = []
  let pending = new Map<number, { configId: string; desiredId: string; value: string }>()
  let nextRpcId = options.firstRpcId ?? FIRST_CONFIG_RPC_ID
  let active = false
  const strictIds = new Set(options.strictConfigIds ?? [])

  const finish = (): void => {
    active = false
    queue = []
    pending = new Map()
    options.onComplete()
  }

  const abortStrict = (configId: string, detail: string): void => {
    active = false
    queue = []
    pending = new Map()
    options.onStrictUnapplied?.(configId, detail)
  }

  const applyNext = (result: unknown): void => {
    if (queue.length === 0) {
      finish()
      return
    }
    const advertised = readHostAcpAdvertisedConfigOptions(result)
    const desired = queue.shift()!
    const option = advertisedForSelection(advertised, desired)
    if (!option) {
      const detail = `ACP session did not advertise config option "${desired.configId}"; keeping its persisted value.`
      if (strictIds.has(desired.configId)) {
        abortStrict(desired.configId, detail)
        return
      }
      options.onWarning(detail)
      applyNext(result)
      return
    }
    const allowed = new Set(desired.values)
    const currentValue = option.currentValue ?? ''
    if (currentValue && allowed.has(currentValue)) {
      applyNext(result)
      return
    }
    const selectedValue =
      option.values.length === 0
        ? desired.values[0]
        : desired.values.find((value) => option.values.includes(value))
    if (!selectedValue) {
      const requested =
        desired.values.length === 1
          ? `"${desired.values[0]}"`
          : `any allowed value (${desired.values.map((value) => `"${value}"`).join(', ')})`
      const detail = `ACP session does not offer ${requested} for config option "${option.id}"; keeping its persisted value.`
      if (strictIds.has(desired.configId)) {
        abortStrict(desired.configId, detail)
        return
      }
      options.onWarning(detail)
      applyNext(result)
      return
    }
    const rpcId = nextRpcId++
    pending.set(rpcId, { configId: option.id, desiredId: desired.configId, value: selectedValue })
    options.write(rpcId, 'session/set_config_option', {
      sessionId,
      configId: option.id,
      value: selectedValue
    })
  }

  return {
    begin(input) {
      sessionId = nonEmptyString(input.sessionId)
      queue = input.selections.filter(
        (selection) => nonEmptyString(selection.configId) && selection.values.some(nonEmptyString)
      )
      pending = new Map()
      if (!sessionId || queue.length === 0) {
        finish()
        return
      }
      if (readHostAcpAdvertisedConfigOptions(input.result).length === 0) {
        finish()
        return
      }
      active = true
      applyNext(input.result)
    },
    acceptFrame(frame) {
      if (!active) return false
      const id = frame.id
      if (typeof id !== 'number' || !pending.has(id)) return false
      const pendingConfig = pending.get(id)!
      pending.delete(id)
      if (frame.error) {
        const error = record(frame.error)
        const message =
          typeof error?.message === 'string' && error.message.trim()
            ? error.message.trim()
            : 'request error'
        const detail = `ACP session config "${pendingConfig.configId}" was not applied: ${message}`
        if (strictIds.has(pendingConfig.desiredId)) {
          abortStrict(pendingConfig.desiredId, detail)
          return true
        }
        options.onWarning(detail)
        applyNext({ configOptions: [] })
        return true
      }
      if (frame.result) {
        applyNext(frame.result)
        return true
      }
      return false
    }
  }
}
