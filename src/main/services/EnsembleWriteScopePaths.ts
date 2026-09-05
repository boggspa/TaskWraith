import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ConcurrentLaneWriteScope } from '../store/types'

/**
 * Pure write-scope normalization and path helpers extracted from
 * EnsembleOrchestrator. Prefix/glob matching stays the existing coarse
 * directory-root approximation; this module does not change admission or
 * capability policy.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function normalizeConcurrentWriteScopes(
  rawScopes: unknown,
  approvedBy: ConcurrentLaneWriteScope['approvedBy'],
  approvedAt: string
): ConcurrentLaneWriteScope[] {
  const rawList = Array.isArray(rawScopes) ? rawScopes : [rawScopes]
  const scopes: ConcurrentLaneWriteScope[] = []
  for (const raw of rawList.slice(0, 24)) {
    const scope = normalizeConcurrentWriteScope(raw, approvedBy, approvedAt)
    if (scope) scopes.push(scope)
  }
  return scopes
}

export function normalizeConcurrentWriteScope(
  raw: unknown,
  approvedBy: ConcurrentLaneWriteScope['approvedBy'],
  approvedAt: string
): ConcurrentLaneWriteScope | null {
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (!value || value.includes('\0')) return null
    if (/^workspace$/i.test(value)) return { kind: 'workspace', approvedBy, approvedAt }
    return {
      kind: value.includes('*') ? 'glob' : 'path',
      path: value,
      approvedBy,
      approvedAt
    }
  }
  if (!isPlainRecord(raw)) return null
  const kindRaw = String(raw.kind || raw.type || '')
    .trim()
    .toLowerCase()
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : undefined
  if (kindRaw === 'workspace') {
    return { kind: 'workspace', approvedBy, approvedAt, ...(reason ? { reason } : {}) }
  }
  if ((kindRaw === 'path' || kindRaw === 'glob') && path && !path.includes('\0')) {
    return {
      kind: kindRaw,
      path,
      approvedBy,
      approvedAt,
      ...(reason ? { reason } : {})
    }
  }
  if (!kindRaw && path && !path.includes('\0')) {
    return {
      kind: path.includes('*') ? 'glob' : 'path',
      path,
      approvedBy,
      approvedAt,
      ...(reason ? { reason } : {})
    }
  }
  return null
}

export function pathIsInsideOrSame(rootPath: string, targetPath: string): boolean {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  if (root === target) return true
  const rel = relative(root, target)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export function resolveScopePath(workspacePath: string, scopePath: string): string {
  return isAbsolute(scopePath) ? resolve(scopePath) : resolve(workspacePath, scopePath)
}

export function writeScopeAllowsResource(
  scope: ConcurrentLaneWriteScope,
  workspacePath: string,
  resourcePath: string
): boolean {
  if (scope.kind === 'workspace') return true
  if (!scope.path) return false
  if (scope.kind === 'path') {
    const target = resolveScopePath(workspacePath, scope.path)
    return pathIsInsideOrSame(target, resourcePath)
  }
  const wildcardIndex = scope.path.indexOf('*')
  const staticPrefix = wildcardIndex === -1 ? scope.path : scope.path.slice(0, wildcardIndex)
  const normalizedPrefix = staticPrefix.replace(/[\\/]+$/, '')
  const target = resolveScopePath(workspacePath, normalizedPrefix || '.')
  return pathIsInsideOrSame(target, resourcePath)
}

export function toWorkspaceRelative(workspacePath: string, resourcePath: string): string {
  const rel = relative(resolve(workspacePath), resolve(resourcePath))
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : resolve(resourcePath)
}

export function isVagueUserPreflightScope(scope: ConcurrentLaneWriteScope): boolean {
  if (scope.kind === 'workspace') return true
  const normalized = (scope.path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
  return (
    !normalized ||
    normalized === '.' ||
    normalized === '/' ||
    normalized === '*' ||
    normalized === '**' ||
    normalized === '**/*'
  )
}

export function scopeStaticRoot(
  workspacePath: string,
  scope: ConcurrentLaneWriteScope
): string | null {
  if (scope.kind === 'workspace') return resolve(workspacePath)
  if (!scope.path) return null
  if (scope.kind === 'path') return resolveScopePath(workspacePath, scope.path)
  const wildcardIndex = scope.path.indexOf('*')
  const staticPrefix = wildcardIndex === -1 ? scope.path : scope.path.slice(0, wildcardIndex)
  const normalizedPrefix = (() => {
    if (wildcardIndex < 0 || /[\\/]$/.test(staticPrefix)) return staticPrefix.replace(/[\\/]+$/, '')
    const slashIndex = Math.max(staticPrefix.lastIndexOf('/'), staticPrefix.lastIndexOf('\\'))
    return slashIndex >= 0 ? staticPrefix.slice(0, slashIndex).replace(/[\\/]+$/, '') : '.'
  })()
  return resolveScopePath(workspacePath, normalizedPrefix || '.')
}

export function scopeIsInsideWorkspace(
  workspacePath: string,
  scope: ConcurrentLaneWriteScope
): boolean {
  const root = scopeStaticRoot(workspacePath, scope)
  return Boolean(root && pathIsInsideOrSame(workspacePath, root))
}

export function writeScopesMayOverlap(
  workspacePath: string,
  left: ConcurrentLaneWriteScope,
  right: ConcurrentLaneWriteScope
): boolean {
  if (left.kind === 'workspace' || right.kind === 'workspace') return true
  const leftRoot = scopeStaticRoot(workspacePath, left)
  const rightRoot = scopeStaticRoot(workspacePath, right)
  if (!leftRoot || !rightRoot) return true
  return pathIsInsideOrSame(leftRoot, rightRoot) || pathIsInsideOrSame(rightRoot, leftRoot)
}

export function formatWriteScope(scope: ConcurrentLaneWriteScope): string {
  return scope.kind === 'workspace' ? 'workspace' : `${scope.kind}:${scope.path || ''}`
}
