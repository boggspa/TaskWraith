import type { CommandRule } from '../store/types'
import { STATIC_SHELL_ARGV_PARSER_VERSION } from './StaticShellArgv'

export const COMMAND_RULE_SCHEMA_VERSION = 1 as const
export const COMMAND_RULE_KIND = 'brokered_shell_exact_argv' as const
export const COMMAND_RULE_RISK_CLASS = 'host_exact_unsandboxed' as const
export const COMMAND_RULE_SIGNATURE_VERSION = 'hmac-sha256-v1' as const
export const COMMAND_RULE_SIGNATURE_DOMAIN = 'taskwraith.command-rule.v1' as const
export const MAX_COMMAND_RULES = 256
export const MAX_COMMAND_RULES_PER_WORKSPACE = 64
export const MAX_COMMAND_RULE_ARGV_ITEMS = 64
export const MAX_COMMAND_RULE_ARG_CHARS = 2_048
export const MAX_COMMAND_RULE_TOTAL_ARG_CHARS = 8 * 1024
export const MAX_COMMAND_RULE_PATH_CHARS = 4 * 1024
export const MAX_COMMAND_RULE_APPROVAL_ID_CHARS = 256

const SHA256_HEX = /^[a-f0-9]{64}$/i

export interface CommandRuleSanitizerOptions {
  resolvePath?: (value: string) => string
  /** Main-only authority filter; applied before dedupe/cap accounting. */
  acceptRule?: (rule: CommandRule) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function isSafeString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    !hasAsciiControlCharacter(value)
  )
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

export function isCommandRuleRelativeCwd(value: unknown): value is string {
  if (value === '.') return true
  if (!isSafeString(value, MAX_COMMAND_RULE_PATH_CHARS)) return false
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function normalizeRelativeCwd(value: string): string {
  return value === '.' ? value : value.replace(/\\/g, '/')
}

function isAbsolutePathLike(value: unknown): value is string {
  return (
    isSafeString(value, MAX_COMMAND_RULE_PATH_CHARS) &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
  )
}

function sanitizeArgv(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_RULE_ARGV_ITEMS) return null
  const argv: string[] = []
  let totalChars = 0
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_COMMAND_RULE_ARG_CHARS) return null
    if (hasAsciiControlCharacter(item)) return null
    totalChars += item.length
    if (totalChars > MAX_COMMAND_RULE_TOTAL_ARG_CHARS) return null
    argv.push(item)
  }
  return argv
}

/**
 * Return the immutable fields whose canonical serialization is fingerprinted.
 * Timestamps and rule ids deliberately do not affect match identity.
 */
export function commandRuleFingerprintPayload(
  rule: Pick<
    CommandRule,
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
): Record<string, unknown> {
  return {
    kind: rule.kind,
    workspaceId: rule.workspaceId,
    primaryWorkspacePath: rule.primaryWorkspacePath,
    primaryWorkspaceRealPath: rule.primaryWorkspaceRealPath,
    cwdRelativePath: rule.cwdRelativePath,
    executableRealPath: rule.executableRealPath,
    executableSha256: rule.executableSha256,
    argv: [...rule.argv],
    parserVersion: rule.parserVersion,
    riskClass: rule.riskClass
  }
}

/**
 * Main signs this whole immutable persisted record. The public fingerprint is
 * useful for dedupe and audit correlation but is deliberately not authority:
 * anyone can recompute SHA-256. Only this HMAC-bound payload can authorize a
 * stored rule at match time.
 */
export function commandRuleSignaturePayload(
  rule: Pick<
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
): Record<string, unknown> {
  return {
    domain: COMMAND_RULE_SIGNATURE_DOMAIN,
    schemaVersion: rule.schemaVersion,
    id: rule.id,
    kind: rule.kind,
    workspaceId: rule.workspaceId,
    primaryWorkspacePath: rule.primaryWorkspacePath,
    primaryWorkspaceRealPath: rule.primaryWorkspaceRealPath,
    cwdRelativePath: rule.cwdRelativePath,
    executableRealPath: rule.executableRealPath,
    executableSha256: rule.executableSha256,
    argv: [...rule.argv],
    parserVersion: rule.parserVersion,
    fingerprint: rule.fingerprint,
    signatureVersion: rule.signatureVersion,
    riskClass: rule.riskClass,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    createdFromApprovalId: rule.createdFromApprovalId ?? null
  }
}

/**
 * Persisted settings are untrusted input at startup. Keep only fully-shaped,
 * bounded records. This sanitizer validates only signature shape; the
 * main-owned CommandRuleService recomputes the fingerprint and verifies the
 * HMAC before a rule can authorize execution.
 */
export function sanitizeCommandRules(
  value: unknown,
  options: CommandRuleSanitizerOptions = {}
): CommandRule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const resolvePath = options.resolvePath ?? ((path) => path)
  const byFingerprint = new Map<string, CommandRule>()
  const idCounts = new Map<string, number>()

  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (!isSafeString(entry.id, MAX_COMMAND_RULE_APPROVAL_ID_CHARS)) continue
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1)
  }

  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (entry.schemaVersion !== COMMAND_RULE_SCHEMA_VERSION) continue
    if (entry.kind !== COMMAND_RULE_KIND) continue
    if (entry.parserVersion !== STATIC_SHELL_ARGV_PARSER_VERSION) continue
    if (entry.riskClass !== COMMAND_RULE_RISK_CLASS) continue
    if (entry.signatureVersion !== COMMAND_RULE_SIGNATURE_VERSION) continue
    if (!isSafeString(entry.id, MAX_COMMAND_RULE_APPROVAL_ID_CHARS)) continue
    if (idCounts.get(entry.id) !== 1) continue
    if (!isAbsolutePathLike(entry.primaryWorkspacePath)) continue
    if (!isAbsolutePathLike(entry.primaryWorkspaceRealPath)) continue
    if (!isCommandRuleRelativeCwd(entry.cwdRelativePath)) continue
    if (!isAbsolutePathLike(entry.executableRealPath)) continue
    if (typeof entry.executableSha256 !== 'string' || !SHA256_HEX.test(entry.executableSha256)) {
      continue
    }
    if (typeof entry.fingerprint !== 'string' || !SHA256_HEX.test(entry.fingerprint)) continue
    if (typeof entry.signature !== 'string' || !SHA256_HEX.test(entry.signature)) continue
    if (!isIsoTimestamp(entry.createdAt) || !isIsoTimestamp(entry.updatedAt)) continue
    const argv = sanitizeArgv(entry.argv)
    if (!argv) continue
    const workspaceId = isSafeString(entry.workspaceId, MAX_COMMAND_RULE_APPROVAL_ID_CHARS)
      ? entry.workspaceId
      : null
    if (!workspaceId) continue
    const createdFromApprovalId =
      entry.createdFromApprovalId === undefined
        ? undefined
        : isSafeString(entry.createdFromApprovalId, MAX_COMMAND_RULE_APPROVAL_ID_CHARS)
          ? entry.createdFromApprovalId
          : null
    if (createdFromApprovalId === null) continue

    let primaryWorkspacePath: string
    let primaryWorkspaceRealPath: string
    let executableRealPath: string
    try {
      primaryWorkspacePath = resolvePath(entry.primaryWorkspacePath)
      primaryWorkspaceRealPath = resolvePath(entry.primaryWorkspaceRealPath)
      executableRealPath = resolvePath(entry.executableRealPath)
    } catch {
      continue
    }
    if (
      !isAbsolutePathLike(primaryWorkspacePath) ||
      !isAbsolutePathLike(primaryWorkspaceRealPath) ||
      !isAbsolutePathLike(executableRealPath)
    ) {
      continue
    }

    const rule: CommandRule = {
      schemaVersion: COMMAND_RULE_SCHEMA_VERSION,
      id: entry.id,
      kind: COMMAND_RULE_KIND,
      workspaceId,
      primaryWorkspacePath,
      primaryWorkspaceRealPath,
      cwdRelativePath: normalizeRelativeCwd(entry.cwdRelativePath),
      executableRealPath,
      executableSha256: entry.executableSha256.toLowerCase(),
      argv,
      parserVersion: STATIC_SHELL_ARGV_PARSER_VERSION,
      fingerprint: entry.fingerprint.toLowerCase(),
      signatureVersion: COMMAND_RULE_SIGNATURE_VERSION,
      signature: entry.signature.toLowerCase(),
      riskClass: COMMAND_RULE_RISK_CLASS,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(createdFromApprovalId ? { createdFromApprovalId } : {})
    }

    if (options.acceptRule && !options.acceptRule(rule)) continue

    const existing = byFingerprint.get(rule.fingerprint)
    if (!existing || Date.parse(rule.updatedAt) >= Date.parse(existing.updatedAt)) {
      byFingerprint.set(rule.fingerprint, rule)
    }
  }

  const workspaceCounts = new Map<string, number>()
  const rules: CommandRule[] = []
  for (const rule of byFingerprint.values()) {
    const workspaceKey = `${rule.workspaceId}\u0000${rule.primaryWorkspaceRealPath}`
    const count = workspaceCounts.get(workspaceKey) ?? 0
    if (count >= MAX_COMMAND_RULES_PER_WORKSPACE || rules.length >= MAX_COMMAND_RULES) continue
    workspaceCounts.set(workspaceKey, count + 1)
    rules.push(rule)
  }
  return rules
}
