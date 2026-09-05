import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConcurrentLaneWriteScope } from '../store/types'
import {
  formatWriteScope,
  isPlainRecord,
  isVagueUserPreflightScope,
  normalizeConcurrentWriteScope,
  normalizeConcurrentWriteScopes,
  pathIsInsideOrSame,
  resolveScopePath,
  scopeIsInsideWorkspace,
  scopeStaticRoot,
  toWorkspaceRelative,
  writeScopeAllowsResource,
  writeScopesMayOverlap
} from './EnsembleWriteScopePaths'

const APPROVED_AT = '2026-09-05T12:00:00.000Z'
const WS = resolve('/tmp/agbench-write-scope-ws')

function pathScope(
  path: string,
  overrides: Partial<ConcurrentLaneWriteScope> = {}
): ConcurrentLaneWriteScope {
  return {
    kind: 'path',
    path,
    approvedBy: 'user-preflight',
    approvedAt: APPROVED_AT,
    ...overrides
  }
}

function globScope(
  path: string,
  overrides: Partial<ConcurrentLaneWriteScope> = {}
): ConcurrentLaneWriteScope {
  return {
    kind: 'glob',
    path,
    approvedBy: 'user-preflight',
    approvedAt: APPROVED_AT,
    ...overrides
  }
}

function workspaceScope(
  overrides: Partial<ConcurrentLaneWriteScope> = {}
): ConcurrentLaneWriteScope {
  return {
    kind: 'workspace',
    approvedBy: 'user-preflight',
    approvedAt: APPROVED_AT,
    ...overrides
  }
}

describe('isPlainRecord', () => {
  it('accepts plain objects and rejects arrays, null, and primitives', () => {
    expect(isPlainRecord({})).toBe(true)
    expect(isPlainRecord({ kind: 'path' })).toBe(true)
    expect(isPlainRecord([])).toBe(false)
    expect(isPlainRecord(null)).toBe(false)
    expect(isPlainRecord(undefined)).toBe(false)
    expect(isPlainRecord('workspace')).toBe(false)
    expect(isPlainRecord(1)).toBe(false)
  })
})

describe('normalizeConcurrentWriteScope', () => {
  it('normalizes workspace strings case-insensitively and trims', () => {
    expect(normalizeConcurrentWriteScope('workspace', 'user-preflight', APPROVED_AT)).toEqual(
      workspaceScope()
    )
    expect(normalizeConcurrentWriteScope(' WORKSPACE ', 'boss', APPROVED_AT)).toEqual(
      workspaceScope({ approvedBy: 'boss' })
    )
  })

  it('infers path vs glob from string wildcards and stamps provenance', () => {
    expect(normalizeConcurrentWriteScope('src/main/index.ts', 'captain', APPROVED_AT)).toEqual(
      pathScope('src/main/index.ts', { approvedBy: 'captain' })
    )
    expect(normalizeConcurrentWriteScope('src/main/**', 'user-preflight', APPROVED_AT)).toEqual(
      globScope('src/main/**')
    )
  })

  it('rejects empty strings, NUL bytes, and non-records', () => {
    expect(normalizeConcurrentWriteScope('', 'user-preflight', APPROVED_AT)).toBeNull()
    expect(normalizeConcurrentWriteScope('   ', 'user-preflight', APPROVED_AT)).toBeNull()
    expect(normalizeConcurrentWriteScope('src/a\0.ts', 'user-preflight', APPROVED_AT)).toBeNull()
    expect(normalizeConcurrentWriteScope(null, 'user-preflight', APPROVED_AT)).toBeNull()
    expect(normalizeConcurrentWriteScope(['src/a.ts'], 'user-preflight', APPROVED_AT)).toBeNull()
  })

  it('accepts object forms, type aliases, inferred kind, and optional reason', () => {
    expect(
      normalizeConcurrentWriteScope(
        { kind: 'workspace', reason: ' whole tree ' },
        'user-preflight',
        APPROVED_AT
      )
    ).toEqual(workspaceScope({ reason: 'whole tree' }))
    expect(
      normalizeConcurrentWriteScope(
        { type: 'path', path: ' src/a.ts ', reason: 'owned file' },
        'boss',
        APPROVED_AT
      )
    ).toEqual(pathScope('src/a.ts', { approvedBy: 'boss', reason: 'owned file' }))
    expect(
      normalizeConcurrentWriteScope({ path: 'src/*.ts' }, 'user-preflight', APPROVED_AT)
    ).toEqual(globScope('src/*.ts'))
    expect(
      normalizeConcurrentWriteScope({ path: 'src/a.ts' }, 'user-preflight', APPROVED_AT)
    ).toEqual(pathScope('src/a.ts'))
  })

  it('rejects unknown kinds, empty paths, and NUL object paths', () => {
    expect(
      normalizeConcurrentWriteScope(
        { kind: 'mystery', path: 'src/a.ts' },
        'user-preflight',
        APPROVED_AT
      )
    ).toBeNull()
    expect(
      normalizeConcurrentWriteScope({ kind: 'path', path: '' }, 'user-preflight', APPROVED_AT)
    ).toBeNull()
    expect(
      normalizeConcurrentWriteScope(
        { kind: 'glob', path: 'src/\0*' },
        'user-preflight',
        APPROVED_AT
      )
    ).toBeNull()
  })
})

describe('normalizeConcurrentWriteScopes', () => {
  it('wraps a single value, drops invalids, and caps at 24 entries', () => {
    expect(normalizeConcurrentWriteScopes('src/a.ts', 'user-preflight', APPROVED_AT)).toEqual([
      pathScope('src/a.ts')
    ])
    expect(
      normalizeConcurrentWriteScopes(
        ['src/a.ts', '', 'src/**', { kind: 'workspace' }],
        'captain',
        APPROVED_AT
      )
    ).toEqual([
      pathScope('src/a.ts', { approvedBy: 'captain' }),
      globScope('src/**', { approvedBy: 'captain' }),
      workspaceScope({ approvedBy: 'captain' })
    ])
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const normalized = normalizeConcurrentWriteScopes(many, 'user-preflight', APPROVED_AT)
    expect(normalized).toHaveLength(24)
    expect(normalized[0]?.path).toBe('src/f0.ts')
    expect(normalized[23]?.path).toBe('src/f23.ts')
  })
})

describe('pathIsInsideOrSame / resolveScopePath', () => {
  it('treats identical and descendant paths as inside, siblings as outside', () => {
    const root = resolve(WS, 'src/main')
    expect(pathIsInsideOrSame(root, root)).toBe(true)
    expect(pathIsInsideOrSame(root, resolve(WS, 'src/main/index.ts'))).toBe(true)
    expect(pathIsInsideOrSame(root, resolve(WS, 'src/renderer/App.tsx'))).toBe(false)
    expect(pathIsInsideOrSame(resolve(WS, 'src/main/index.ts'), root)).toBe(false)
  })

  it('resolves relative scope paths against the workspace and keeps absolute paths', () => {
    expect(resolveScopePath(WS, 'src/main/index.ts')).toBe(resolve(WS, 'src/main/index.ts'))
    expect(resolveScopePath(WS, '/etc/hosts')).toBe(resolve('/etc/hosts'))
  })
})

describe('writeScopeAllowsResource', () => {
  it('allows any resource for workspace scope and denies missing non-workspace paths', () => {
    expect(writeScopeAllowsResource(workspaceScope(), WS, resolve(WS, 'anywhere.ts'))).toBe(true)
    expect(
      writeScopeAllowsResource(
        { kind: 'path', approvedBy: 'user-preflight', approvedAt: APPROVED_AT },
        WS,
        resolve(WS, 'src/a.ts')
      )
    ).toBe(false)
  })

  it('allows a path scope for the path itself and descendants only', () => {
    const scope = pathScope('src/main')
    expect(writeScopeAllowsResource(scope, WS, resolve(WS, 'src/main'))).toBe(true)
    expect(writeScopeAllowsResource(scope, WS, resolve(WS, 'src/main/index.ts'))).toBe(true)
    expect(writeScopeAllowsResource(scope, WS, resolve(WS, 'src/renderer/App.tsx'))).toBe(false)
  })

  it('uses the glob static prefix as a directory root, including filename prefixes', () => {
    const dirGlob = globScope('src/main/**')
    expect(writeScopeAllowsResource(dirGlob, WS, resolve(WS, 'src/main/index.ts'))).toBe(true)
    expect(writeScopeAllowsResource(dirGlob, WS, resolve(WS, 'src/renderer/App.tsx'))).toBe(false)

    const filePrefixGlob = globScope('src/main/Ensemble*.ts')
    expect(
      writeScopeAllowsResource(filePrefixGlob, WS, resolve(WS, 'src/main/EnsembleOrchestrator.ts'))
    ).toBe(false)
    expect(
      writeScopeAllowsResource(filePrefixGlob, WS, resolve(WS, 'src/main/Ensemble/extra.ts'))
    ).toBe(true)
  })
})

describe('toWorkspaceRelative', () => {
  it('returns posix-relative paths inside the workspace and resolved paths outside', () => {
    expect(toWorkspaceRelative(WS, resolve(WS, 'src/main/index.ts'))).toBe('src/main/index.ts')
    expect(toWorkspaceRelative(WS, resolve('/etc/hosts'))).toBe(resolve('/etc/hosts'))
  })
})

describe('isVagueUserPreflightScope', () => {
  it('treats workspace and root/wildcard paths as vague, concrete paths as not', () => {
    expect(isVagueUserPreflightScope(workspaceScope())).toBe(true)
    expect(isVagueUserPreflightScope(pathScope(''))).toBe(true)
    expect(isVagueUserPreflightScope(pathScope('.'))).toBe(true)
    expect(isVagueUserPreflightScope(pathScope('./'))).toBe(true)
    expect(isVagueUserPreflightScope(pathScope('/'))).toBe(true)
    expect(isVagueUserPreflightScope(globScope('*'))).toBe(true)
    expect(isVagueUserPreflightScope(globScope('**'))).toBe(true)
    expect(isVagueUserPreflightScope(globScope('**/*'))).toBe(true)
    expect(isVagueUserPreflightScope(pathScope('src/main/index.ts'))).toBe(false)
    expect(isVagueUserPreflightScope(globScope('src/**'))).toBe(false)
  })
})

describe('scopeStaticRoot / scopeIsInsideWorkspace', () => {
  it('roots workspace and path scopes, and trims glob prefixes at the last slash when needed', () => {
    expect(scopeStaticRoot(WS, workspaceScope())).toBe(resolve(WS))
    expect(scopeStaticRoot(WS, pathScope('src/main/index.ts'))).toBe(
      resolve(WS, 'src/main/index.ts')
    )
    expect(scopeStaticRoot(WS, globScope('src/main/**'))).toBe(resolve(WS, 'src/main'))
    expect(scopeStaticRoot(WS, globScope('src/main/Ensemble*.ts'))).toBe(resolve(WS, 'src/main'))
    expect(scopeStaticRoot(WS, globScope('*.ts'))).toBe(resolve(WS))
    expect(
      scopeStaticRoot(WS, { kind: 'glob', approvedBy: 'user-preflight', approvedAt: APPROVED_AT })
    ).toBeNull()
  })

  it('accepts in-workspace roots and rejects external absolute scopes', () => {
    expect(scopeIsInsideWorkspace(WS, pathScope('src/main'))).toBe(true)
    expect(scopeIsInsideWorkspace(WS, globScope('src/**'))).toBe(true)
    expect(scopeIsInsideWorkspace(WS, workspaceScope())).toBe(true)
    expect(scopeIsInsideWorkspace(WS, pathScope('/etc/hosts'))).toBe(false)
  })
})

describe('writeScopesMayOverlap', () => {
  it('overlaps workspace against anything and nested or identical path roots', () => {
    expect(writeScopesMayOverlap(WS, workspaceScope(), pathScope('src/a.ts'))).toBe(true)
    expect(writeScopesMayOverlap(WS, pathScope('src/main'), pathScope('src/main/index.ts'))).toBe(
      true
    )
    expect(writeScopesMayOverlap(WS, pathScope('src/main'), pathScope('src/main'))).toBe(true)
    expect(writeScopesMayOverlap(WS, pathScope('src/main'), pathScope('src/renderer'))).toBe(false)
  })

  it('uses glob static roots for overlap, and treats a missing root as overlapping', () => {
    expect(
      writeScopesMayOverlap(WS, globScope('src/main/**'), pathScope('src/main/index.ts'))
    ).toBe(true)
    expect(
      writeScopesMayOverlap(WS, globScope('src/main/Ensemble*.ts'), pathScope('src/renderer'))
    ).toBe(false)
    expect(
      writeScopesMayOverlap(
        WS,
        { kind: 'path', approvedBy: 'user-preflight', approvedAt: APPROVED_AT },
        pathScope('src/a.ts')
      )
    ).toBe(true)
  })
})

describe('formatWriteScope', () => {
  it('formats workspace vs path/glob identities', () => {
    expect(formatWriteScope(workspaceScope())).toBe('workspace')
    expect(formatWriteScope(pathScope('src/main/index.ts'))).toBe('path:src/main/index.ts')
    expect(formatWriteScope(globScope('src/**'))).toBe('glob:src/**')
    expect(
      formatWriteScope({ kind: 'path', approvedBy: 'user-preflight', approvedAt: APPROVED_AT })
    ).toBe('path:')
  })
})
