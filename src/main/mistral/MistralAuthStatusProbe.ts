import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'child_process'
import { encodeAcpFrame, parseAcpStreamChunk } from '../acp/AcpProtocol'
import { buildMistralInitializeParams } from './MistralAcpClient'

export const MISTRAL_AUTH_STATUS_METHOD = '_auth/status'
export const MISTRAL_AUTH_STATUS_TIMEOUT_MS = 5_000

export type MistralVibeAuthState = 'authenticated' | 'missing' | 'unknown'
export type MistralVibeAuthProbeStatus = 'verified' | 'unsupported' | 'failed'

export interface MistralVibeAuthProbeResult {
  authState: MistralVibeAuthState
  credentialPresent: boolean | null
  authSource: string | null
  version: string | null
  probeStatus: MistralVibeAuthProbeStatus
}

export type SpawnMistralAuthProbeProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams

export interface MistralVibeAuthProbeOptions {
  binaryPath: string
  env: Readonly<Record<string, string | undefined>>
  clientVersion?: string
  timeoutMs?: number
  spawnProcess?: SpawnMistralAuthProbeProcess
}

const INITIALIZE_RPC_ID = 1
const AUTH_STATUS_RPC_ID = 2
const SAFE_AUTH_SOURCES = new Set([
  'signed_out',
  'auth_not_required',
  'os_keyring',
  'vibe_home_env_file',
  'process_env',
  'unsupported_provider'
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeVersionFromInitializeResult(result: unknown): string | null {
  const agentInfo = asRecord(asRecord(result)?.agentInfo)
  const version = typeof agentInfo?.version === 'string' ? agentInfo.version.trim() : ''
  return version ? version.slice(0, 128) : null
}

/**
 * Reduce Vibe's credential-opaque `_auth/status` response to the three states
 * TaskWraith renders. Only the documented source enum is retained; arbitrary
 * provider output never crosses into Settings as auth metadata.
 */
export function normalizeMistralVibeAuthStatus(
  result: unknown
): Omit<MistralVibeAuthProbeResult, 'version'> {
  const record = asRecord(result)
  const rawSource = typeof record?.authState === 'string' ? record.authState.trim() : ''
  const authSource = SAFE_AUTH_SOURCES.has(rawSource) ? rawSource : null

  if (record?.authenticated === true) {
    return {
      authState: 'authenticated',
      credentialPresent: true,
      authSource,
      probeStatus: 'verified'
    }
  }
  if (record?.authenticated === false) {
    return {
      authState: 'missing',
      credentialPresent: false,
      authSource,
      probeStatus: 'verified'
    }
  }
  return {
    authState: 'unknown',
    credentialPresent: null,
    authSource,
    probeStatus: 'failed'
  }
}

function failedProbe(
  probeStatus: Exclude<MistralVibeAuthProbeStatus, 'verified'>,
  version: string | null = null
): MistralVibeAuthProbeResult {
  return {
    authState: 'unknown',
    credentialPresent: null,
    authSource: null,
    version,
    probeStatus
  }
}

/**
 * Ask Vibe itself whether its active provider is authenticated.
 *
 * This starts `vibe-acp`, performs only `initialize` and the official
 * `_auth/status` extension, then terminates it. Vibe owns the credential lookup;
 * TaskWraith never opens the keyring item or credential file and never starts a
 * session/model request. The child returns only a boolean plus a source enum
 * such as `os_keyring`.
 */
export function probeMistralVibeAuthStatus(
  options: MistralVibeAuthProbeOptions
): Promise<MistralVibeAuthProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams | null = null
    let carry = ''
    let version: string | null = null
    let authRequestSent = false
    let settled = false
    let timeout: NodeJS.Timeout | null = null

    const finish = (result: MistralVibeAuthProbeResult): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (child) {
        child.stdout.removeListener('data', onStdout)
        child.removeListener('error', onError)
        child.removeListener('close', onClose)
        try {
          child.stdin.end()
        } catch {
          // The response is already authoritative; a closed stdin is cleanup only.
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // The child may already have exited after writing its response.
        }
      }
      resolve(result)
    }

    const writeRequest = (id: number, method: string, params: unknown): void => {
      if (!child || settled) return
      try {
        child.stdin.write(encodeAcpFrame({ jsonrpc: '2.0', id, method, params }))
      } catch {
        finish(failedProbe('failed', version))
      }
    }

    const onStdout = (chunk: Buffer | string): void => {
      const parsed = parseAcpStreamChunk(chunk.toString(), carry)
      carry = parsed.carry
      for (const message of parsed.messages) {
        if (message.id === INITIALIZE_RPC_ID) {
          if (message.error || !Object.prototype.hasOwnProperty.call(message, 'result')) {
            finish(failedProbe('failed'))
            return
          }
          version = safeVersionFromInitializeResult(message.result)
          if (!authRequestSent) {
            authRequestSent = true
            writeRequest(AUTH_STATUS_RPC_ID, MISTRAL_AUTH_STATUS_METHOD, {})
          }
          continue
        }
        if (message.id !== AUTH_STATUS_RPC_ID) continue
        if (message.error) {
          const error = asRecord(message.error)
          finish(failedProbe(error?.code === -32601 ? 'unsupported' : 'failed', version))
          return
        }
        const normalized = normalizeMistralVibeAuthStatus(message.result)
        finish({ ...normalized, version })
        return
      }
    }

    const onError = (): void => finish(failedProbe('failed', version))
    const onClose = (): void => finish(failedProbe('failed', version))
    const onStdinError = (): void => finish(failedProbe('failed', version))

    try {
      const spawnProcess: SpawnMistralAuthProbeProcess =
        options.spawnProcess ||
        ((command, args, spawnOptions) =>
          spawn(command, args, {
            ...spawnOptions,
            stdio: ['pipe', 'pipe', 'pipe']
          }))
      child = spawnProcess(options.binaryPath, [], { env: { ...options.env } })
    } catch {
      finish(failedProbe('failed'))
      return
    }

    child.stdout.on('data', onStdout)
    child.stderr.resume()
    // A child that exits between initialize and auth/status can surface EPIPE
    // on stdin separately from the ChildProcess close/error events.
    child.stdin.on('error', onStdinError)
    child.on('error', onError)
    child.on('close', onClose)
    timeout = setTimeout(
      () => finish(failedProbe('failed', version)),
      options.timeoutMs ?? MISTRAL_AUTH_STATUS_TIMEOUT_MS
    )
    timeout.unref?.()

    writeRequest(
      INITIALIZE_RPC_ID,
      'initialize',
      buildMistralInitializeParams(options.clientVersion?.trim() || 'status-probe')
    )
  })
}
