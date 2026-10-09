import {
  resolveFullAccessNativeRun,
  type FullAccessNativeRunManager
} from '../run/FullAccessNativeDecision'
import {
  buildContainedCursorWriteArgv,
  type BuildContainedCursorWriteArgvInput
} from '../cursor/CursorCliArgs'
import { buildGrokAcpCliArgs, type BuildGrokAcpCliArgsInput } from '../grok/GrokCliArgs'
import { buildPiRpcArgs, type PiRpcArgsInput } from '../pi/PiCliArgs'
import { buildDevinAcpCliArgs } from '../devin/DevinCliArgs'
import {
  mistralSessionModeForSeat,
  mistralSessionModeFallbacksForSeat
} from '../mistral/MistralCliArgs'

/** Main-owned admitted run lookup. Never accept a preset copied from tool args. */
export interface NativeFullAccessAuthority {
  manager: FullAccessNativeRunManager
  runId: string | undefined
}

export function nativeFullAccessIsActive(authority: NativeFullAccessAuthority): boolean {
  return resolveFullAccessNativeRun(authority.manager, authority.runId) !== null
}

function replaceOption(args: string[], option: string, value: string): string[] {
  const index = args.indexOf(option)
  if (index < 0) throw new Error(`Expected launcher option ${option}.`)
  const next = [...args]
  next[index + 1] = value
  return next
}

/** Options verified in installed cursor-agent --help; other tiers retain existing argv. */
export function cursorNativeFullAccessArgv(
  input: BuildContainedCursorWriteArgvInput,
  authority: NativeFullAccessAuthority
): string[] {
  const args = buildContainedCursorWriteArgv(input)
  if (!nativeFullAccessIsActive(authority)) return args
  return buildCursorFullAccessArgv(input)
}

/** Pure argv producer; callers must first verify the run's Full Access authority. */
export function buildCursorFullAccessArgv(input: BuildContainedCursorWriteArgvInput): string[] {
  const args = buildContainedCursorWriteArgv(input)
  const full = replaceOption(args, '--sandbox', 'disabled')
  if (!full.includes('--force')) full.push('--force')
  full.push('--approve-mcps')
  return full
}

/** Grok's installed CLI accepts bypassPermissions; omit the restricted tool allowlist. */
export function grokNativeFullAccessArgv(
  input: BuildGrokAcpCliArgsInput,
  authority: NativeFullAccessAuthority
): string[] {
  if (!nativeFullAccessIsActive(authority)) return buildGrokAcpCliArgs(input)
  const args = buildGrokAcpCliArgs({ ...input, readOnlySeat: false })
  const index = args.indexOf('--tools')
  if (index < 0) throw new Error('Expected Grok native tool allowlist.')
  args.splice(index, 2)
  args.unshift('--permission-mode', 'bypassPermissions')
  return args
}

/** Pi --help lists these seven built-ins. Existing extension allowlists remain intact. */
export const PI_FULL_ACCESS_NATIVE_TOOLS = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls'
] as const

export function piNativeFullAccessArgv(
  input: PiRpcArgsInput,
  authority: NativeFullAccessAuthority
): string[] {
  const args = buildPiRpcArgs(input)
  if (!nativeFullAccessIsActive(authority)) return args
  const index = args.indexOf('--tools')
  if (index < 0) throw new Error('Expected Pi native tool allowlist.')
  return replaceOption(
    args,
    '--tools',
    [...new Set([...PI_FULL_ACCESS_NATIVE_TOOLS, ...args[index + 1].split(',')])].join(',')
  )
}

/** Vibe's advertised ACP agent-mode schema includes auto-approve, not an argv flag. */
export function mistralNativeFullAccessSessionMode(
  readOnlySeat: boolean,
  authority: NativeFullAccessAuthority
): { configId: 'mode'; value: string; fallbackValues: readonly string[] } {
  if (nativeFullAccessIsActive(authority))
    return { configId: 'mode', value: 'auto-approve', fallbackValues: [] }
  return {
    configId: 'mode',
    value: mistralSessionModeForSeat(readOnlySeat),
    fallbackValues: mistralSessionModeFallbacksForSeat(readOnlySeat)
  }
}

/** Devin acp exposes no permission-mode flag; native permissions are accepted via ACP. */
export function devinNativeFullAccessLaunch(
  model: string | null | undefined,
  authority: NativeFullAccessAuthority
): { args: string[]; autoApproveNativePermissions: boolean } {
  return {
    args: buildDevinAcpCliArgs(model),
    autoApproveNativePermissions: nativeFullAccessIsActive(authority)
  }
}
