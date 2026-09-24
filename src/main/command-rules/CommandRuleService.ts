import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AppSettings, CommandRule } from '../store/types'
import {
  COMMAND_RULE_KIND,
  COMMAND_RULE_RISK_CLASS,
  COMMAND_RULE_SCHEMA_VERSION,
  COMMAND_RULE_SIGNATURE_VERSION,
  MAX_COMMAND_RULES,
  MAX_COMMAND_RULES_PER_WORKSPACE,
  commandRuleFingerprintPayload,
  commandRuleSignaturePayload,
  sanitizeCommandRules
} from './CommandRuleSchema'
import {
  STATIC_SHELL_ARGV_PARSER_VERSION,
  parseStaticShellArgv,
  type StaticShellArgvParseFailure
} from './StaticShellArgv'

const MAX_COMMAND_RULE_EXECUTABLE_BYTES = 64 * 1024 * 1024
const HMAC_SHA256_HEX = /^[a-f0-9]{64}$/i

export type CommandRuleCompileFailure =
  | StaticShellArgvParseFailure
  | 'unsupported_tool'
  | 'workspace_required'
  | 'workspace_id_required'
  | 'workspace_not_directory'
  | 'cwd_not_relative'
  | 'cwd_outside_workspace'
  | 'cwd_not_directory'
  | 'relative_executable_outside_workspace'
  | 'executable_not_found'
  | 'executable_not_file'
  | 'executable_too_large'
  | 'invalid_candidate'

export type CommandRuleCompileResult =
  | { ok: true; candidate: CommandRuleCandidate }
  | { ok: false; reason: CommandRuleCompileFailure }

/**
 * Main-owned, compiled form of a pending command-rule offer. It includes only
 * concrete direct-argv facts; approval/UI code can bind it to a request id
 * without reconstructing a command from renderer text.
 */
export interface CommandRuleCandidate {
  schemaVersion: 1
  kind: 'brokered_shell_exact_argv'
  workspaceId: string
  primaryWorkspacePath: string
  primaryWorkspaceRealPath: string
  cwdRelativePath: string
  resolvedCwd: string
  executableRealPath: string
  executableSha256: string
  argv: string[]
  parserVersion: 'static-shell-argv-v1'
  fingerprint: string
  riskClass: 'host_exact_unsandboxed'
  approvalId?: string
}

export interface CompileCommandRuleCandidateInput {
  /** Only TaskWraith's canonical brokered shell tool is eligible in v1. */
  toolName: 'run_shell_command'
  command: unknown
  cwd?: unknown
  workspacePath?: string | null
  workspaceId: string
  approvalId?: string | null
  /** Must be the exact sanitized execution environment when supplied. */
  environment?: Readonly<Record<string, string | undefined>>
}

export interface MatchCommandRuleInput extends CompileCommandRuleCandidateInput {
  toolName: 'run_shell_command'
}

export interface CommandRuleMatch {
  rule: CommandRule
  executableRealPath: string
  argv: string[]
  cwd: string
  fingerprint: string
}

export interface CommandRuleUpsertResult {
  rule: CommandRule
  created: boolean
}

export interface RemoveCommandRuleInput {
  id: string
  workspacePath: string
  workspaceId: string
}

export interface CommandRuleServiceOptions {
  getSettings: () => Pick<AppSettings, 'commandRules'>
  updateSettings: (partial: Pick<AppSettings, 'commandRules'>) => void
  /** Main-owned signing authority. Never expose this to renderer or MCP code. */
  signingAuthority: CommandRuleSigningAuthority
  now?: () => Date
  createId?: () => string
  getEnvironment?: () => Readonly<Record<string, string | undefined>>
}

export interface CommandRuleSigningAuthority {
  sign: (canonicalPayload: string) => string
  verify: (canonicalPayload: string, signature: string) => boolean
}

/** Convenience HMAC authority for main-process composition and focused tests. */
export function createCommandRuleHmacSigningAuthority(
  secret: string | Uint8Array
): CommandRuleSigningAuthority {
  const secretBytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret)
  if (secretBytes.length < 32) {
    throw new TypeError('Command rule signing requires at least 32 bytes of main-owned secret.')
  }
  const sign = (canonicalPayload: string): string =>
    crypto.createHmac('sha256', secretBytes).update(canonicalPayload).digest('hex')
  return {
    sign,
    verify: (canonicalPayload, signature) => {
      if (!HMAC_SHA256_HEX.test(signature)) return false
      try {
        const expected = Buffer.from(sign(canonicalPayload), 'hex')
        const received = Buffer.from(signature, 'hex')
        return expected.length === received.length && crypto.timingSafeEqual(expected, received)
      } catch {
        return false
      }
    }
  }
}

export class CommandRuleError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_candidate' | 'rule_limit_reached'
  ) {
    super(message)
    this.name = 'CommandRuleError'
  }
}

/**
 * Persistence and exact-match authority for brokered shell command rules.
 * This service deliberately does not inspect run posture or policy; future
 * approval orchestration owns those stronger gates and calls `match` only when
 * an exact rule is eligible to provide authority.
 */
export class CommandRuleService {
  constructor(private readonly options: CommandRuleServiceOptions) {
    if (!options.signingAuthority) {
      throw new Error('CommandRuleService requires a main-owned signing authority.')
    }
  }

  compileCandidate(input: CompileCommandRuleCandidateInput): CommandRuleCompileResult {
    if (input.toolName !== 'run_shell_command') {
      return { ok: false, reason: 'unsupported_tool' }
    }
    const parsed = parseStaticShellArgv(input.command)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }

    const workspacePath = nonEmptyString(input.workspacePath)
    if (!workspacePath) return { ok: false, reason: 'workspace_required' }
    const workspaceId = normalizedOptionalString(input.workspaceId)
    if (!workspaceId) return { ok: false, reason: 'workspace_id_required' }

    let primaryWorkspacePath: string
    let primaryWorkspaceRealPath: string
    try {
      primaryWorkspacePath = path.resolve(workspacePath)
      primaryWorkspaceRealPath = fs.realpathSync(primaryWorkspacePath)
      if (!fs.statSync(primaryWorkspaceRealPath).isDirectory()) {
        return { ok: false, reason: 'workspace_not_directory' }
      }
    } catch {
      return { ok: false, reason: 'workspace_not_directory' }
    }

    const relativeCwd = normalizeRequestedCwd(input.cwd)
    if (!relativeCwd) return { ok: false, reason: 'cwd_not_relative' }

    let resolvedCwd: string
    let cwdRelativePath: string
    try {
      const lexicalCwd = path.resolve(primaryWorkspacePath, relativeCwd)
      resolvedCwd = fs.realpathSync(lexicalCwd)
      if (!fs.statSync(resolvedCwd).isDirectory()) return { ok: false, reason: 'cwd_not_directory' }
      if (!isInside(primaryWorkspaceRealPath, resolvedCwd)) {
        return { ok: false, reason: 'cwd_outside_workspace' }
      }
      cwdRelativePath = toNormalizedRelativePath(primaryWorkspaceRealPath, resolvedCwd)
    } catch {
      return { ok: false, reason: 'cwd_not_directory' }
    }

    const environment = input.environment ?? this.options.getEnvironment?.() ?? process.env
    const executable = resolveExecutable({
      requested: parsed.value.executable,
      cwd: resolvedCwd,
      workspaceRealPath: primaryWorkspaceRealPath,
      environment
    })
    if (!executable.ok) return executable

    const executableHash = hashExecutable(executable.realPath)
    if (!executableHash.ok) return executableHash

    const approvalId = normalizedOptionalString(input.approvalId)
    const candidateWithoutFingerprint: Omit<CommandRuleCandidate, 'fingerprint'> = {
      schemaVersion: COMMAND_RULE_SCHEMA_VERSION,
      kind: COMMAND_RULE_KIND,
      workspaceId,
      primaryWorkspacePath,
      primaryWorkspaceRealPath,
      cwdRelativePath,
      resolvedCwd,
      executableRealPath: executable.realPath,
      executableSha256: executableHash.sha256,
      argv: [...parsed.value.argv],
      parserVersion: STATIC_SHELL_ARGV_PARSER_VERSION,
      riskClass: COMMAND_RULE_RISK_CLASS,
      ...(approvalId ? { approvalId } : {})
    }
    const fingerprint = fingerprintFor(candidateWithoutFingerprint)
    const candidate = { ...candidateWithoutFingerprint, fingerprint }
    if (!isValidCandidate(candidate)) return { ok: false, reason: 'invalid_candidate' }
    return { ok: true, candidate }
  }

  match(input: MatchCommandRuleInput): CommandRuleMatch | null {
    const compiled = this.compileCandidate(input)
    if (!compiled.ok) return null
    const candidate = compiled.candidate
    const rule = this.rules().find((entry) => entry.fingerprint === candidate.fingerprint)
    if (!rule) return null
    // A stored fingerprint is only an index. Recompute it before it can grant
    // authority, so a hand-edited settings record cannot manufacture a match.
    if (fingerprintFor(rule) !== rule.fingerprint || !this.hasValidRuleSignature(rule)) return null
    if (
      rule.workspaceId !== candidate.workspaceId ||
      rule.primaryWorkspacePath !== candidate.primaryWorkspacePath ||
      rule.primaryWorkspaceRealPath !== candidate.primaryWorkspaceRealPath ||
      rule.cwdRelativePath !== candidate.cwdRelativePath ||
      rule.executableRealPath !== candidate.executableRealPath ||
      rule.executableSha256 !== candidate.executableSha256 ||
      !sameArgv(rule.argv, candidate.argv)
    ) {
      return null
    }
    return {
      rule,
      executableRealPath: candidate.executableRealPath,
      argv: [...candidate.argv],
      cwd: candidate.resolvedCwd,
      fingerprint: candidate.fingerprint
    }
  }

  upsert(candidate: CommandRuleCandidate): CommandRuleUpsertResult {
    if (!isValidCandidate(candidate) || fingerprintFor(candidate) !== candidate.fingerprint) {
      throw new CommandRuleError('Command rule candidate is invalid.', 'invalid_candidate')
    }
    const rules = this.rules()
    const existing = rules.find((rule) => rule.fingerprint === candidate.fingerprint)
    if (existing) return { rule: existing, created: false }

    const workspaceRuleCount = rules.filter(
      (rule) =>
        rule.workspaceId === candidate.workspaceId &&
        rule.primaryWorkspaceRealPath === candidate.primaryWorkspaceRealPath
    ).length
    if (
      rules.length >= MAX_COMMAND_RULES ||
      workspaceRuleCount >= MAX_COMMAND_RULES_PER_WORKSPACE
    ) {
      throw new CommandRuleError('The command-rule limit has been reached.', 'rule_limit_reached')
    }

    const now = (this.options.now?.() ?? new Date()).toISOString()
    const unsignedRule: Omit<CommandRule, 'signature'> = {
      schemaVersion: COMMAND_RULE_SCHEMA_VERSION,
      kind: COMMAND_RULE_KIND,
      id: this.options.createId?.() ?? crypto.randomUUID(),
      workspaceId: candidate.workspaceId,
      primaryWorkspacePath: candidate.primaryWorkspacePath,
      primaryWorkspaceRealPath: candidate.primaryWorkspaceRealPath,
      cwdRelativePath: candidate.cwdRelativePath,
      executableRealPath: candidate.executableRealPath,
      executableSha256: candidate.executableSha256,
      argv: [...candidate.argv],
      parserVersion: STATIC_SHELL_ARGV_PARSER_VERSION,
      fingerprint: candidate.fingerprint,
      signatureVersion: COMMAND_RULE_SIGNATURE_VERSION,
      riskClass: COMMAND_RULE_RISK_CLASS,
      createdAt: now,
      updatedAt: now,
      ...(candidate.approvalId ? { createdFromApprovalId: candidate.approvalId } : {})
    }
    const canonicalSignaturePayload = signaturePayloadFor(unsignedRule)
    let signature = ''
    let signatureValid = false
    try {
      signature = this.options.signingAuthority.sign(canonicalSignaturePayload)
      signatureValid =
        HMAC_SHA256_HEX.test(signature) &&
        this.options.signingAuthority.verify(canonicalSignaturePayload, signature)
    } catch {
      throw new CommandRuleError(
        'Command rule signer could not sign the rule.',
        'invalid_candidate'
      )
    }
    if (!signatureValid) {
      throw new CommandRuleError(
        'Command rule signer returned an invalid signature.',
        'invalid_candidate'
      )
    }
    const rule: CommandRule = { ...unsignedRule, signature: signature.toLowerCase() }
    this.options.updateSettings({ commandRules: [...rules, rule] })
    return { rule, created: true }
  }

  remove(input: RemoveCommandRuleInput): boolean {
    const id = normalizedOptionalString(input.id)
    const expectedWorkspaceId = normalizedOptionalString(input.workspaceId)
    const expectedWorkspacePath = normalizedOptionalString(input.workspacePath)
    if (!id || !expectedWorkspaceId || !expectedWorkspacePath) return false
    const canonicalWorkspacePath = path.resolve(expectedWorkspacePath)
    if (canonicalWorkspacePath !== expectedWorkspacePath) return false
    const rules = this.rules()
    const next = rules.filter((rule) => {
      if (rule.id !== id) return true
      if (rule.workspaceId !== expectedWorkspaceId) return true
      if (rule.primaryWorkspaceRealPath !== canonicalWorkspacePath) return true
      return false
    })
    if (next.length === rules.length) return false
    this.options.updateSettings({ commandRules: next })
    return true
  }

  list(): CommandRule[] {
    return this.rules().map((rule) => ({ ...rule, argv: [...rule.argv] }))
  }

  private rules(): CommandRule[] {
    return (
      sanitizeCommandRules(this.options.getSettings().commandRules, {
        resolvePath: (value) => path.resolve(value),
        acceptRule: (rule) => this.hasValidRuleSignature(rule)
      }) ?? []
    )
  }

  private hasValidRuleSignature(rule: CommandRule): boolean {
    if (
      rule.signatureVersion !== COMMAND_RULE_SIGNATURE_VERSION ||
      !HMAC_SHA256_HEX.test(rule.signature)
    ) {
      return false
    }
    try {
      return this.options.signingAuthority.verify(signaturePayloadFor(rule), rule.signature)
    } catch {
      return false
    }
  }
}

function normalizedOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return normalizedOptionalString(value)
}

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function normalizeRequestedCwd(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return '.'
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    hasAsciiControlCharacter(value)
  ) {
    return null
  }
  if (path.isAbsolute(value)) return null
  const segments = value.split('/')
  if (segments.some((segment) => segment === '..')) return null
  return value
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function toNormalizedRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target)
  return relative ? relative.split(path.sep).join('/') : '.'
}

function resolveExecutable(input: {
  requested: string
  cwd: string
  workspaceRealPath: string
  environment: Readonly<Record<string, string | undefined>>
}): { ok: true; realPath: string } | { ok: false; reason: CommandRuleCompileFailure } {
  const requestedHasPath = input.requested.includes('/') || input.requested.includes('\\')
  if (requestedHasPath) {
    if (input.requested.includes('\\')) return { ok: false, reason: 'executable_not_found' }
    const lexical = path.isAbsolute(input.requested)
      ? path.resolve(input.requested)
      : path.resolve(input.cwd, input.requested)
    if (!path.isAbsolute(input.requested) && !isInside(input.workspaceRealPath, lexical)) {
      return { ok: false, reason: 'relative_executable_outside_workspace' }
    }
    const executable = validateExecutable(lexical)
    if (
      executable.ok &&
      !path.isAbsolute(input.requested) &&
      !isInside(input.workspaceRealPath, executable.realPath)
    ) {
      return { ok: false, reason: 'relative_executable_outside_workspace' }
    }
    return executable
  }

  const searchPath = input.environment.PATH ?? ''
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue
    const resolved = validateExecutable(path.join(directory, input.requested))
    if (resolved.ok) return resolved
  }
  return { ok: false, reason: 'executable_not_found' }
}

function validateExecutable(
  candidate: string
): { ok: true; realPath: string } | { ok: false; reason: CommandRuleCompileFailure } {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    const realPath = fs.realpathSync(candidate)
    if (!fs.statSync(realPath).isFile()) return { ok: false, reason: 'executable_not_file' }
    return { ok: true, realPath }
  } catch {
    return { ok: false, reason: 'executable_not_found' }
  }
}

function hashExecutable(
  executableRealPath: string
):
  | { ok: true; sha256: string }
  | { ok: false; reason: 'executable_not_found' | 'executable_too_large' } {
  try {
    if (fs.statSync(executableRealPath).size > MAX_COMMAND_RULE_EXECUTABLE_BYTES) {
      return { ok: false, reason: 'executable_too_large' }
    }
    return {
      ok: true,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(executableRealPath)).digest('hex')
    }
  } catch {
    return { ok: false, reason: 'executable_not_found' }
  }
}

function fingerprintFor(
  value: Pick<
    CommandRuleCandidate | CommandRule,
    | 'kind'
    | 'workspaceId'
    | 'primaryWorkspacePath'
    | 'primaryWorkspaceRealPath'
    | 'cwdRelativePath'
    | 'executableRealPath'
    | 'executableSha256'
    | 'argv'
    | 'parserVersion'
    | 'riskClass'
  >
): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify(commandRuleFingerprintPayload(value)))
    .digest('hex')
}

function signaturePayloadFor(
  value: Pick<
    CommandRule,
    | 'schemaVersion'
    | 'id'
    | 'kind'
    | 'workspaceId'
    | 'primaryWorkspacePath'
    | 'primaryWorkspaceRealPath'
    | 'cwdRelativePath'
    | 'executableRealPath'
    | 'executableSha256'
    | 'argv'
    | 'parserVersion'
    | 'fingerprint'
    | 'signatureVersion'
    | 'riskClass'
    | 'createdAt'
    | 'updatedAt'
    | 'createdFromApprovalId'
  >
): string {
  return stableStringify(commandRuleSignaturePayload(value))
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isValidCandidate(value: CommandRuleCandidate): boolean {
  const sanitized = sanitizeCommandRules(
    [
      {
        ...value,
        id: 'candidate-validation',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        signatureVersion: COMMAND_RULE_SIGNATURE_VERSION,
        signature: '0'.repeat(64),
        ...(value.approvalId ? { createdFromApprovalId: value.approvalId } : {})
      }
    ],
    { resolvePath: (entryPath) => path.resolve(entryPath) }
  )
  const normalized = sanitized?.[0]
  if (!normalized) return false
  if (
    normalized.workspaceId !== value.workspaceId ||
    normalized.primaryWorkspacePath !== value.primaryWorkspacePath ||
    normalized.primaryWorkspaceRealPath !== value.primaryWorkspaceRealPath ||
    normalized.cwdRelativePath !== value.cwdRelativePath ||
    normalized.executableRealPath !== value.executableRealPath ||
    normalized.executableSha256 !== value.executableSha256 ||
    normalized.fingerprint !== value.fingerprint ||
    !sameArgv(normalized.argv, value.argv)
  ) {
    return false
  }
  try {
    const workspaceRealPath = fs.realpathSync(value.primaryWorkspacePath)
    const cwdRealPath = fs.realpathSync(value.resolvedCwd)
    const executableRealPath = fs.realpathSync(value.executableRealPath)
    if (
      workspaceRealPath !== value.primaryWorkspaceRealPath ||
      cwdRealPath !== value.resolvedCwd ||
      executableRealPath !== value.executableRealPath ||
      !fs.statSync(workspaceRealPath).isDirectory() ||
      !fs.statSync(cwdRealPath).isDirectory() ||
      !fs.statSync(executableRealPath).isFile() ||
      !isInside(workspaceRealPath, cwdRealPath) ||
      toNormalizedRelativePath(workspaceRealPath, cwdRealPath) !== value.cwdRelativePath
    ) {
      return false
    }
    const executableHash = hashExecutable(executableRealPath)
    return executableHash.ok && executableHash.sha256 === value.executableSha256
  } catch {
    return false
  }
}
