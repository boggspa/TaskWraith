import { spawn, type ChildProcess } from 'child_process'
import {
  appendLimitedOutput,
  asRecord,
  readStringField,
  stringifyJsonFragment,
  stripAnsi
} from '../gemini/GeminiCapabilityParsing'
import {
  GEMINI_CAPABILITY_TIMEOUT_MS,
  type GeminiCapabilityItem,
  type GeminiCapabilityKind,
  type GeminiCapabilityProcessResult
} from '../geminiCapabilityTypes'

export interface ProviderCapabilityProbeDependencies {
  resolveGeminiBinary: () => Promise<{ binaryPath: string | null; error?: string }>
  createCliEnv: (extra: Record<string, string>, binaryPath: string) => NodeJS.ProcessEnv
  spawnProcess?: typeof spawn
}

function extractCapabilityJsonEntries(
  value: unknown,
  kind: GeminiCapabilityKind
): Array<{ key?: string; value: unknown }> {
  if (Array.isArray(value)) {
    return value.map((entry) => ({ value: entry }))
  }

  const record = asRecord(value)
  if (!record) {
    return value === undefined || value === null ? [] : [{ value }]
  }

  const candidateKeys = [
    kind,
    kind === 'mcp' ? 'servers' : kind,
    kind === 'mcp' ? 'mcpServers' : kind,
    'items',
    'data',
    'results'
  ]

  for (const key of candidateKeys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) {
      return candidate.map((entry) => ({ value: entry }))
    }

    const candidateRecord = asRecord(candidate)
    if (candidateRecord) {
      return Object.entries(candidateRecord).map(([entryKey, entryValue]) => ({
        key: entryKey,
        value: entryValue
      }))
    }
  }

  if (Object.values(record).every((entry) => entry && typeof entry === 'object')) {
    return Object.entries(record).map(([entryKey, entryValue]) => ({
      key: entryKey,
      value: entryValue
    }))
  }

  return [{ value }]
}

export function parseCapabilityJsonItems(
  value: unknown,
  kind: GeminiCapabilityKind
): GeminiCapabilityItem[] {
  return extractCapabilityJsonEntries(value, kind).map((entry, index) => {
    const record = asRecord(entry.value)
    const fallbackName = entry.key || `${kind} ${index + 1}`

    if (!record) {
      const raw = stringifyJsonFragment(entry.value)
      return {
        id: fallbackName,
        name: String(entry.value || fallbackName),
        raw
      }
    }

    const name =
      readStringField(record, [
        'name',
        'displayName',
        'title',
        'id',
        'server',
        'extension',
        'skill'
      ]) || fallbackName
    const id = readStringField(record, ['id', 'name', 'server', 'extension', 'skill']) || name
    const status =
      readStringField(record, ['status', 'state', 'lifecycleState', 'connectionStatus']) ||
      (typeof record.enabled === 'boolean'
        ? record.enabled
          ? 'enabled'
          : 'disabled'
        : undefined) ||
      (typeof record.active === 'boolean' ? (record.active ? 'active' : 'inactive') : undefined) ||
      (typeof record.installed === 'boolean'
        ? record.installed
          ? 'installed'
          : 'not installed'
        : undefined)
    const detail = readStringField(record, ['description', 'summary', 'path', 'command', 'version'])

    return {
      id,
      name,
      status,
      detail,
      raw: stringifyJsonFragment(entry.value)
    }
  })
}

export function parseCapabilityRawItems(
  stdout: string,
  kind: GeminiCapabilityKind
): GeminiCapabilityItem[] {
  return stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-+|=\s]+$/.test(line))
    .filter((line) => !/^(name|id)\b.*\b(status|state|description|command)\b/i.test(line))
    .filter((line) => !/^no\s+.+\s+(configured|found|installed|available)\.?$/i.test(line))
    .filter((line) => !/^.+:\s*$/.test(line))
    .map((line, index) => {
      const normalized = line.replace(/^[*•-]\s*/, '')
      const columns = normalized
        .split(/\s*\|\s*|\t+|\s{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
      const statusMatch = normalized.match(
        /\b(active|enabled|disabled|installed|running|connected|disconnected|ok|error|failed|unavailable|loaded|trusted|untrusted|inactive)\b/i
      )
      const name = columns[0] || normalized
      const detail = columns.length > 1 ? columns.slice(1).join(' · ') : undefined

      return {
        id: `${kind}-${index + 1}`,
        name,
        status: statusMatch?.[1],
        detail,
        raw: line
      }
    })
}

export function createProviderCapabilityProbe(deps: ProviderCapabilityProbeDependencies): {
  runGeminiCapabilityCommand: (
    args: string[],
    cwd?: string
  ) => Promise<GeminiCapabilityProcessResult>
} {
  const spawnProcess = deps.spawnProcess || spawn

  async function runGeminiCapabilityCommand(
    args: string[],
    cwd?: string
  ): Promise<GeminiCapabilityProcessResult> {
    const resolved = await deps.resolveGeminiBinary()
    if (!resolved.binaryPath) {
      return {
        args,
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        error: resolved.error || 'Gemini CLI is not configured.'
      }
    }
    const geminiBinaryPath = resolved.binaryPath

    return new Promise((resolveResult) => {
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false
      let finished = false
      const finish = (exitCode: number | null, error?: string): void => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        resolveResult({ args, stdout, stderr, exitCode, timedOut, error, truncated })
      }

      let process: ChildProcess
      try {
        process = spawnProcess(geminiBinaryPath, args, {
          cwd,
          shell: false,
          env: deps.createCliEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }, geminiBinaryPath)
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        resolveResult({ args, stdout, stderr, exitCode: null, timedOut: false, error: message })
        return
      }

      const timeout = setTimeout(() => {
        timedOut = true
        process.kill()
      }, GEMINI_CAPABILITY_TIMEOUT_MS)

      process.stdout?.on('data', (data: Buffer) => {
        const appended = appendLimitedOutput(stdout, data)
        stdout = appended.value
        truncated = truncated || appended.truncated
      })

      process.stderr?.on('data', (data: Buffer) => {
        const appended = appendLimitedOutput(stderr, data)
        stderr = appended.value
        truncated = truncated || appended.truncated
      })

      process.on('close', (code) => finish(code))
      process.on('error', (error) => finish(null, error.message))
    })
  }

  return { runGeminiCapabilityCommand }
}
