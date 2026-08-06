/**
 * Wave 3.6e — HostInstallIdentity.
 *
 * Pins the six requirements of Boss ruling `host-arc-hostid-ruling`:
 * stability, per-instance distinctness, cold-start directory creation, atomic
 * first write, a documented corrupt-file side, and observability. Real
 * filesystem round-trips throughout — a mocked `fs` would prove nothing about
 * the durability this module exists to provide.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HOST_PROTOCOL_MAX_ID } from '../../shared/hostProtocol'

import { hostRuntimeDataDir } from './HostMainComposition'
import {
  HOST_INSTALL_IDENTITY_FILE_NAME,
  HOST_INSTALL_IDENTITY_SCHEMA_VERSION,
  hostInstallIdentityPath,
  resolveHostInstallId,
  type HostInstallIdentityWarning
} from './HostInstallIdentity'

let root: string
let warnings: HostInstallIdentityWarning[]

/** Collect warnings so no test silently depends on the console default. */
function onWarn(warning: HostInstallIdentityWarning): void {
  warnings.push(warning)
}

function userData(name = 'instance-a'): string {
  return join(root, name)
}

function identityFile(name = 'instance-a'): string {
  return join(hostRuntimeDataDir(userData(name)), HOST_INSTALL_IDENTITY_FILE_NAME)
}

/** Write raw bytes into the identity slot, creating the dir if needed. */
function seedIdentityFile(contents: string, name = 'instance-a'): void {
  mkdirSync(hostRuntimeDataDir(userData(name)), { recursive: true })
  writeFileSync(identityFile(name), contents, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-install-identity-'))
  warnings = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ */
/*  1. Stability                                                       */
/* ------------------------------------------------------------------ */

describe('stability (requirement 1)', () => {
  it('returns the same id for two calls on one directory', () => {
    const first = resolveHostInstallId({ userDataPath: userData(), onWarn })
    const second = resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(second).toBe(first)
    expect(warnings).toEqual([])
  })

  it('survives a simulated process restart over the same directory', () => {
    // This module holds no in-memory cache, so a fresh call IS a restart:
    // the id can only come back from disk.
    const before = resolveHostInstallId({
      userDataPath: userData(),
      onWarn,
      generateId: () => 'first-boot-id'
    })

    // A "restarted" process would generate a different id if it ignored disk.
    const after = resolveHostInstallId({
      userDataPath: userData(),
      onWarn,
      generateId: () => 'second-boot-id-must-not-win'
    })

    expect(before).toBe('first-boot-id')
    expect(after).toBe('first-boot-id')
  })

  it('does not rewrite the file once an id exists', () => {
    resolveHostInstallId({ userDataPath: userData(), onWarn })
    const original = readFileSync(identityFile(), 'utf8')

    resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(readFileSync(identityFile(), 'utf8')).toBe(original)
  })
})

/* ------------------------------------------------------------------ */
/*  2. Per-instance distinctness                                       */
/* ------------------------------------------------------------------ */

describe('per-instance distinctness (requirement 2)', () => {
  it('gives different ids to different userData directories', () => {
    // The multi-instance dev lane runs concurrent apps with separate
    // userData. A shared id would make clients conflate two hosts and
    // cross-wire generations/cursors.
    const a = resolveHostInstallId({ userDataPath: userData('instance-a'), onWarn })
    const b = resolveHostInstallId({ userDataPath: userData('instance-b'), onWarn })

    expect(a).not.toBe(b)
  })

  it('keeps each instance stable independently', () => {
    const a1 = resolveHostInstallId({ userDataPath: userData('instance-a'), onWarn })
    const b1 = resolveHostInstallId({ userDataPath: userData('instance-b'), onWarn })
    const a2 = resolveHostInstallId({ userDataPath: userData('instance-a'), onWarn })
    const b2 = resolveHostInstallId({ userDataPath: userData('instance-b'), onWarn })

    expect(a2).toBe(a1)
    expect(b2).toBe(b1)
  })
})

/* ------------------------------------------------------------------ */
/*  3. Cold start — directory may not exist                            */
/* ------------------------------------------------------------------ */

describe('cold start (requirement 3)', () => {
  it('creates the host data directory when it does not exist', () => {
    // index.ts evaluates this INSIDE the options literal, which runs before
    // the bootstrap that would otherwise have created the directory.
    const dir = hostRuntimeDataDir(userData())
    expect(existsSync(dir)).toBe(false)

    const id = resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(existsSync(dir)).toBe(true)
    expect(id.length).toBeGreaterThan(0)
  })

  it('creates missing intermediate directories rather than throwing', () => {
    const deep = join(root, 'does', 'not', 'exist', 'yet')
    expect(existsSync(deep)).toBe(false)

    const id = resolveHostInstallId({ userDataPath: deep, onWarn })

    expect(id.length).toBeGreaterThan(0)
    expect(existsSync(hostRuntimeDataDir(deep))).toBe(true)
  })

  it('writes a readable document on cold start', () => {
    resolveHostInstallId({ userDataPath: userData(), onWarn, generateId: () => 'cold-start-id' })

    const parsed = JSON.parse(readFileSync(identityFile(), 'utf8')) as Record<string, unknown>
    expect(parsed.hostId).toBe('cold-start-id')
    expect(parsed.schemaVersion).toBe(HOST_INSTALL_IDENTITY_SCHEMA_VERSION)
    expect(typeof parsed.createdAt).toBe('string')
  })
})

/* ------------------------------------------------------------------ */
/*  4. Atomic first write                                              */
/* ------------------------------------------------------------------ */

describe('atomic first write (requirement 4)', () => {
  it('leaves no scratch file behind', () => {
    resolveHostInstallId({ userDataPath: userData(), onWarn })

    const residue = readdirSync(hostRuntimeDataDir(userData())).filter((n) => n.endsWith('.tmp'))
    expect(residue).toEqual([])
  })

  it('yields to a racer that already landed an id', () => {
    // Simulates the other half of a first-boot race: by the time we look,
    // a peer has already renamed its document into place. We must adopt it
    // rather than overwrite, or the two callers diverge permanently.
    seedIdentityFile(
      JSON.stringify({
        schemaVersion: HOST_INSTALL_IDENTITY_SCHEMA_VERSION,
        hostId: 'racer-won',
        createdAt: new Date().toISOString()
      })
    )

    const id = resolveHostInstallId({
      userDataPath: userData(),
      onWarn,
      generateId: () => 'we-lost-the-race'
    })

    expect(id).toBe('racer-won')
    expect(warnings).toEqual([])
  })

  it('returns the id that is actually on disk, not merely the one generated', () => {
    // The read-back is what makes racing callers converge. If the function
    // returned its own candidate without re-reading, this would still pass
    // by luck — so assert the two agree, which is the invariant that matters.
    const id = resolveHostInstallId({ userDataPath: userData(), onWarn })
    const onDisk = JSON.parse(readFileSync(identityFile(), 'utf8')) as { hostId: string }

    expect(id).toBe(onDisk.hostId)
  })
})

/* ------------------------------------------------------------------ */
/*  5. Corrupt / empty file                                            */
/* ------------------------------------------------------------------ */

describe('damaged file handling (requirement 5)', () => {
  it('regenerates and quarantines an empty file', () => {
    seedIdentityFile('')

    const id = resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(id.length).toBeGreaterThan(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.kind).toBe('regenerated-after-damage')
  })

  it('regenerates and quarantines unparseable JSON', () => {
    seedIdentityFile('{ this is not json')

    const id = resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(id.length).toBeGreaterThan(0)
    expect(warnings[0]?.kind).toBe('regenerated-after-damage')
  })

  it('rejects a document whose hostId is missing or empty', () => {
    seedIdentityFile(JSON.stringify({ schemaVersion: 1, hostId: '   ' }))

    const id = resolveHostInstallId({ userDataPath: userData(), onWarn, generateId: () => 'fresh' })

    expect(id).toBe('fresh')
    expect(warnings[0]?.kind).toBe('regenerated-after-damage')
  })

  it('rejects an over-long hostId the protocol would refuse', () => {
    // hostProtocol gates hostId with isNonEmptyString(..., HOST_PROTOCOL_MAX_ID).
    // Returning something longer would boot a Host that fails every handshake.
    seedIdentityFile(JSON.stringify({ hostId: 'x'.repeat(HOST_PROTOCOL_MAX_ID + 1) }))

    const id = resolveHostInstallId({ userDataPath: userData(), onWarn, generateId: () => 'fresh' })

    expect(id).toBe('fresh')
  })

  it('PRESERVES the damaged bytes instead of deleting them', () => {
    // Forensics: an identity change is serious enough that the original must
    // remain inspectable.
    seedIdentityFile('{ damaged-original')

    resolveHostInstallId({ userDataPath: userData(), onWarn })

    const quarantined = readdirSync(hostRuntimeDataDir(userData())).filter((n) =>
      n.includes('.corrupt-')
    )
    expect(quarantined).toHaveLength(1)
    expect(
      readFileSync(join(hostRuntimeDataDir(userData()), quarantined[0] as string), 'utf8')
    ).toBe('{ damaged-original')
  })

  it('is stable again after recovering from damage', () => {
    seedIdentityFile('')
    const recovered = resolveHostInstallId({ userDataPath: userData(), onWarn })
    const next = resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(next).toBe(recovered)
  })
})

/* ------------------------------------------------------------------ */
/*  6. Observability                                                   */
/* ------------------------------------------------------------------ */

describe('observability (requirement 6)', () => {
  it('reports the quarantine path and a human reason', () => {
    seedIdentityFile('not json at all')

    resolveHostInstallId({ userDataPath: userData(), onWarn })

    const warning = warnings[0]
    expect(warning?.kind).toBe('regenerated-after-damage')
    if (warning?.kind === 'regenerated-after-damage') {
      expect(warning.quarantinePath).toContain('.corrupt-')
      expect(warning.reason.length).toBeGreaterThan(0)
      expect(warning.identityPath).toBe(identityFile())
    }
  })

  it('stays silent on the healthy path', () => {
    resolveHostInstallId({ userDataPath: userData(), onWarn })
    resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(warnings).toEqual([])
  })

  it('never silently swallows a regeneration when no sink is injected', () => {
    // Default sink must be observable. Silence here is the exact failure that
    // makes a client look like it is hallucinating stale state.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedIdentityFile('')

    resolveHostInstallId({ userDataPath: userData() })

    expect(spy).toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/*  Protocol conformance + input validation                            */
/* ------------------------------------------------------------------ */

describe('protocol conformance', () => {
  it('generates an id the Host protocol would accept', () => {
    const id = resolveHostInstallId({ userDataPath: userData(), onWarn })

    expect(id.trim()).toBe(id)
    expect(id.length).toBeGreaterThan(0)
    expect(id.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_ID)
  })

  it('falls back to a real UUID when an injected generator returns junk', () => {
    const id = resolveHostInstallId({ userDataPath: userData(), onWarn, generateId: () => '  ' })

    expect(id.length).toBeGreaterThan(0)
    expect(id.trim()).toBe(id)
  })

  it('exposes a pure path helper', () => {
    expect(hostInstallIdentityPath(userData())).toBe(identityFile())
    expect(existsSync(hostRuntimeDataDir(userData()))).toBe(false)
  })
})

describe('input validation', () => {
  it('refuses a missing options object', () => {
    expect(() => resolveHostInstallId(undefined as never)).toThrow(/options object/)
  })

  it('refuses an empty userDataPath rather than writing to the process cwd', () => {
    expect(() => resolveHostInstallId({ userDataPath: '   ' })).toThrow(/userDataPath/)
  })
})

/* ------------------------------------------------------------------ */
/*  Import isolation                                                   */
/* ------------------------------------------------------------------ */

const SOURCE = readFileSync(join(__dirname, 'HostInstallIdentity.ts'), 'utf-8')

/** Strip comments so prose about Electron cannot satisfy or break a code pin. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('import isolation', () => {
  it('does not import electron', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]electron['"]/)
    expect(SOURCE).not.toMatch(/require\s*\(\s*['"]electron['"]/)
  })

  it('never names a window surface in code', () => {
    const code = stripComments(SOURCE)
    expect(code).not.toMatch(/BrowserWindow/)
    expect(code).not.toMatch(/webContents/)
  })

  it('does not import AppStore, Bridge or store value modules', () => {
    const valueImportPatterns = [
      /import\s+(?!type)(?!\{[^}]*\})\s*.*from\s+['"]\.\.\/AppStore/,
      /import\s+(?!type)(?!\{[^}]*\})\s*.*from\s+['"]\.\.\/BridgeActionExecutor/,
      /import\s+(?!type)(?!\{[^}]*\})\s*.*from\s+['"]\.\.\/store/
    ]
    for (const pattern of valueImportPatterns) {
      expect(SOURCE).not.toMatch(pattern)
    }
  })

  it('does not import from composition roots', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]\.\.\/index/)
    expect(SOURCE).not.toMatch(/from\s+['"]\.\.\/App/)
    expect(SOURCE).not.toMatch(/from\s+['"]\.\.\/EnsembleOrchestrator/)
  })
})
