import { canonicalTaskWraithToolName } from '../TaskWraithMcpTools'

type JsonRecord = Record<string, unknown>
const CANVAS_FILL_JSON_ENVELOPE_KEYS = new Set(['arguments', 'input', 'parameters', 'params'])

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isCanvasFillToolIdentity(value: unknown): boolean {
  return typeof value === 'string' && canonicalTaskWraithToolName(value) === 'canvas_fill'
}

function containsCanvasFillInvocation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCanvasFillInvocation)
  if (!isRecord(value)) return false
  if (
    isCanvasFillToolIdentity(value.tool) ||
    isCanvasFillToolIdentity(value.name) ||
    isCanvasFillToolIdentity(value.toolName) ||
    isCanvasFillToolIdentity(value.tool_name) ||
    isCanvasFillToolIdentity(value.mcpToolName) ||
    isCanvasFillToolIdentity(value.targetToolName)
  ) {
    return true
  }
  return Object.entries(value).some(([key, entry]) => {
    if (CANVAS_FILL_JSON_ENVELOPE_KEYS.has(key) && typeof entry === 'string') {
      try {
        return containsCanvasFillInvocation(JSON.parse(entry))
      } catch {
        return false
      }
    }
    return containsCanvasFillInvocation(entry)
  })
}

/**
 * Strip `canvas_fill` typed values from durable projections, including nested
 * capability and permission-retry envelopes. Live provider results and the
 * transient desktop approval preview keep their exact arguments.
 */
export function redactCanvasFillValueForDurableStorage<T>(payload: T): T {
  const redact = (value: unknown, inheritedCanvasFill = false): unknown => {
    if (Array.isArray(value)) return value.map((entry) => redact(entry, inheritedCanvasFill))
    if (!isRecord(value)) return value
    const next: JsonRecord = {}
    for (const [key, entry] of Object.entries(value)) {
      if (inheritedCanvasFill && key === 'targetArgumentsSha256' && typeof entry === 'string') {
        next.targetArgumentsFingerprintRedacted = true
        continue
      }
      if (inheritedCanvasFill && key === 'value' && typeof entry === 'string') {
        next.value = '[redacted]'
        next.valueRedacted = true
        continue
      }
      if (
        inheritedCanvasFill &&
        (key === 'failure' || key === 'priorFailure' || key === 'rationale') &&
        typeof entry === 'string'
      ) {
        next[key] = '[redacted canvas_fill narrative]'
        next[`${key}Redacted`] = true
        continue
      }
      if (
        inheritedCanvasFill &&
        CANVAS_FILL_JSON_ENVELOPE_KEYS.has(key) &&
        typeof entry === 'string'
      ) {
        try {
          next[key] = JSON.stringify(redact(JSON.parse(entry), true))
        } catch {
          next[key] = '[redacted canvas_fill arguments]'
        }
        next[`${key}Redacted`] = true
        continue
      }
      next[key] = redact(entry, inheritedCanvasFill)
    }
    return next
  }
  return redact(payload, containsCanvasFillInvocation(payload)) as T
}
