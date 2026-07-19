import { createHash } from 'crypto'
import { createRequire } from 'module'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION } from '../../shared/cursorStartupPosture'
import {
  captureCursorBinaryIdentity,
  CursorRuntimeAdmissionGate,
  CURSOR_RUNTIME_ATTESTATION_SOURCE,
  CURSOR_RUNTIME_QUALIFICATION_SCOPE,
  CURSOR_UNATTESTED_DEVELOPMENT_SOURCE,
  cursorRuntimeQualificationsPresent,
  EMBEDDED_CURSOR_RUNTIME_QUALIFICATIONS,
  fingerprintCursorCapability,
  projectCursorCapability,
  projectCursorRuntimeQualificationsFromManifest,
  runBoundedCursorInventoryProbes,
  sameCursorBinaryIdentity,
  verifyEmbeddedCursorRuntimeQualificationProjection,
  type CursorBinaryIdentity,
  type CursorBinaryStatIdentity,
  type CursorInventorySurfaces,
  type CursorProbeCapture,
  type CursorRuntimeQualification
} from './CursorRuntimeAdmission'

const require = createRequire(import.meta.url)
const canary = require('../../../scripts/provider-containment-canary.cjs') as {
  capabilityFingerprint: (document: unknown) => string
}

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

function sha(char: string): string {
  return `sha256:${char.repeat(64)}`
}

function statIdentity(seed = '1'): CursorBinaryStatIdentity {
  return {
    dev: seed,
    ino: seed,
    mode: '33261',
    nlink: '1',
    uid: seed,
    gid: seed,
    rdev: '0',
    size: '100',
    blksize: '4096',
    blocks: '8',
    mtimeNs: seed,
    ctimeNs: seed
  }
}

function binaryIdentity(digest = sha('a'), seed = '1'): CursorBinaryIdentity {
  return { realPath: '/real/cursor-agent', sha256: digest, stat: statIdentity(seed) }
}

function capture(
  args: readonly string[],
  stdout: string,
  overrides: Partial<CursorProbeCapture> = {}
): CursorProbeCapture {
  return {
    args,
    stdout,
    stderr: '',
    code: 0,
    signal: null,
    error: null,
    ...overrides
  }
}

// Minimal cursor-agent help containing the containment-critical surface the
// admission gate checks for: --print, --sandbox, and the `mcp` command.
function inventorySurfaces(): CursorInventorySurfaces {
  return {
    version: capture(['--version'], '2026.07.16-899851b\n'),
    help: capture(
      ['--help'],
      [
        'Usage: agent [options] [command] [prompt...]',
        '',
        'Options:',
        '  -p, --print          Print responses to console',
        '  --sandbox <mode>     Explicitly enable or disable sandbox mode',
        '  --mode <mode>        Start in the given execution mode',
        '',
        'Commands:',
        '  mcp                  Manage MCP servers',
        '  login                Authenticate with Cursor',
        ''
      ].join('\n')
    )
  }
}

function admissionInput(
  overrides: Partial<{
    binaryPath: string
    isPackaged: boolean
    environment: NodeJS.ProcessEnv
  }> = {}
) {
  return {
    binaryPath: '/candidate/cursor-agent',
    isPackaged: true,
    ...overrides
  }
}

function qualification(
  surfaces = inventorySurfaces(),
  overrides: Partial<CursorRuntimeQualification> = {}
): CursorRuntimeQualification {
  const capability = projectCursorCapability('2026.07.16-899851b', surfaces)
  return {
    binarySha256: sha('a'),
    platform: process.platform,
    arch: process.arch,
    scope: CURSOR_RUNTIME_QUALIFICATION_SCOPE,
    version: '2026.07.16-899851b',
    capabilityFingerprint: fingerprintCursorCapability(capability),
    postureVersion: CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION,
    attestationSource: CURSOR_RUNTIME_ATTESTATION_SOURCE,
    ...overrides
  }
}

describe('Cursor runtime admission — fail-closed shipped state', () => {
  it('ships an empty embedded roster so no managed Cursor run is admissible', () => {
    expect(EMBEDDED_CURSOR_RUNTIME_QUALIFICATIONS).toEqual([])
    expect(cursorRuntimeQualificationsPresent()).toBe(false)
    expect(cursorRuntimeQualificationsPresent([qualification()])).toBe(true)
  })

  it('blocks an empty roster and unknown SHA without executing the binary', async () => {
    const probeSurfaces = vi.fn(async () => inventorySurfaces())
    const gate = new CursorRuntimeAdmissionGate([], {
      captureIdentity: async () => binaryIdentity(),
      probeSurfaces
    })

    await expect(gate.admit(admissionInput())).resolves.toMatchObject({
      admitted: false,
      reason: 'unknown_binary'
    })
    expect(probeSurfaces).not.toHaveBeenCalled()
  })

  it('blocks a malformed embedded roster before hashing or probing', async () => {
    const captureIdentity = vi.fn(async () => binaryIdentity())
    const probeSurfaces = vi.fn(async () => inventorySurfaces())
    const gate = new CursorRuntimeAdmissionGate(
      [{ binarySha256: '', scope: CURSOR_RUNTIME_QUALIFICATION_SCOPE }],
      { captureIdentity, probeSurfaces }
    )

    await expect(gate.admit(admissionInput())).resolves.toMatchObject({
      admitted: false,
      reason: 'invalid_qualification_roster'
    })
    expect(captureIdentity).not.toHaveBeenCalled()
    expect(probeSurfaces).not.toHaveBeenCalled()
  })
})

describe('Cursor runtime admission ordering and exact qualification', () => {
  it('hashes first, probes a known SHA, revalidates identity, and returns a branded realpath', async () => {
    const identity = binaryIdentity()
    const captureIdentity = vi.fn(async () => identity)
    const probeSurfaces = vi.fn(async () => inventorySurfaces())
    const gate = new CursorRuntimeAdmissionGate([qualification()], {
      captureIdentity,
      probeSurfaces
    })

    const decision = await gate.admit(admissionInput())
    expect(decision).toMatchObject({
      admitted: true,
      binaryPath: '/real/cursor-agent',
      mode: 'reviewed',
      qualification: { version: '2026.07.16-899851b', scope: CURSOR_RUNTIME_QUALIFICATION_SCOPE }
    })
    expect(captureIdentity).toHaveBeenCalledTimes(2)
    expect(probeSurfaces).toHaveBeenCalledTimes(1)
    expect(captureIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      probeSurfaces.mock.invocationCallOrder[0]
    )
    if (!decision.admitted) throw new Error('expected admission')
    await expect(decision.assertReadyForSpawn()).resolves.toBe('/real/cursor-agent')
    expect(captureIdentity).toHaveBeenCalledTimes(3)
  })

  it('blocks a build missing the sandbox/print/mcp containment surface', async () => {
    const withoutSandbox: CursorInventorySurfaces = {
      version: capture(['--version'], '2026.07.16-899851b\n'),
      help: capture(
        ['--help'],
        ['Options:', '  -p, --print  Print', '', 'Commands:', '  mcp  Manage MCP', ''].join('\n')
      )
    }
    const gate = new CursorRuntimeAdmissionGate(
      [qualification(withoutSandbox, { capabilityFingerprint: sha('c') })],
      {
        captureIdentity: async () => binaryIdentity(),
        probeSurfaces: async () => withoutSandbox
      }
    )
    await expect(gate.admit(admissionInput())).resolves.toMatchObject({
      admitted: false,
      reason: 'capability_mismatch'
    })
  })

  it('blocks exact version/capability drift even when the binary SHA is known', async () => {
    const gate = new CursorRuntimeAdmissionGate(
      [qualification(inventorySurfaces(), { capabilityFingerprint: sha('b') })],
      {
        captureIdentity: async () => binaryIdentity(),
        probeSurfaces: async () => inventorySurfaces()
      }
    )
    await expect(gate.admit(admissionInput())).resolves.toMatchObject({
      admitted: false,
      reason: 'capability_mismatch'
    })
  })

  it('blocks when the descriptor-bound identity changes during probes', async () => {
    const captureIdentity = vi
      .fn<() => Promise<CursorBinaryIdentity>>()
      .mockResolvedValueOnce(binaryIdentity())
      .mockResolvedValueOnce(binaryIdentity(sha('b'), '2'))
    const gate = new CursorRuntimeAdmissionGate([qualification()], {
      captureIdentity,
      probeSurfaces: async () => inventorySurfaces()
    })
    await expect(gate.admit(admissionInput())).resolves.toMatchObject({
      admitted: false,
      reason: 'binary_identity_changed'
    })
  })

  it('runs the known identity probe as a single flight for concurrent callers', async () => {
    let releaseProbe: (surfaces: CursorInventorySurfaces) => void = () => {
      throw new Error('probe did not start')
    }
    const probeSurfaces = vi.fn(
      () =>
        new Promise<CursorInventorySurfaces>((resolve) => {
          releaseProbe = resolve
        })
    )
    const gate = new CursorRuntimeAdmissionGate([qualification()], {
      captureIdentity: async () => binaryIdentity(),
      probeSurfaces
    })
    const first = gate.admit(admissionInput())
    const second = gate.admit(admissionInput())
    await vi.waitFor(() => expect(probeSurfaces).toHaveBeenCalledTimes(1))
    releaseProbe(inventorySurfaces())
    const [left, right] = await Promise.all([first, second])
    expect(left.admitted).toBe(true)
    expect(right).toBe(left)
    expect(probeSurfaces).toHaveBeenCalledTimes(1)
  })

  it('ignores the dev escape hatch when packaged and requires the exact value 1 unpackaged', async () => {
    const probeSurfaces = vi.fn(async () => inventorySurfaces())
    const gate = new CursorRuntimeAdmissionGate([], {
      captureIdentity: async () => binaryIdentity(),
      probeSurfaces
    })
    await expect(
      gate.admit(
        admissionInput({
          isPackaged: true,
          environment: { TASKWRAITH_ALLOW_UNATTESTED_CURSOR_DEV: '1' }
        })
      )
    ).resolves.toMatchObject({ admitted: false, reason: 'unknown_binary' })
    await expect(
      gate.admit(
        admissionInput({
          isPackaged: false,
          environment: { TASKWRAITH_ALLOW_UNATTESTED_CURSOR_DEV: 'true' }
        })
      )
    ).resolves.toMatchObject({ admitted: false, reason: 'unknown_binary' })
    await expect(
      gate.admit(
        admissionInput({
          isPackaged: false,
          environment: { TASKWRAITH_ALLOW_UNATTESTED_CURSOR_DEV: '1' }
        })
      )
    ).resolves.toMatchObject({
      admitted: true,
      mode: 'unattested-development',
      qualification: null,
      attestationSource: CURSOR_UNATTESTED_DEVELOPMENT_SOURCE
    })
    expect(probeSurfaces).toHaveBeenCalledTimes(1)
  })

  it('uses the exact same canonical capability fingerprint as the release canary', () => {
    const projection = projectCursorCapability('2026.07.16-899851b', inventorySurfaces())
    expect(fingerprintCursorCapability(projection)).toBe(canary.capabilityFingerprint(projection))
  })
})

describe('Cursor binary identity and bounded inventory roots', () => {
  it('binds the digest to realpath plus bigint file identity', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'taskwraith-cursor-identity-test-'))
    tempRoots.push(root)
    const binary = join(root, 'cursor-agent')
    await fs.writeFile(binary, 'known bytes', { mode: 0o700 })
    const first = await captureCursorBinaryIdentity(binary)
    expect(first.sha256).toBe(`sha256:${createHash('sha256').update('known bytes').digest('hex')}`)
    expect(first.realPath).toBe(await fs.realpath(binary))
    expect(Object.values(first.stat).every((value) => typeof value === 'string')).toBe(true)

    await fs.writeFile(binary, 'changed bytes', { mode: 0o700 })
    const second = await captureCursorBinaryIdentity(binary)
    expect(sameCursorBinaryIdentity(first, second)).toBe(false)
  })

  it('uses two distinct scrubbed synthetic homes/cwds without leaking Cursor auth', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'taskwraith-cursor-probe-test-'))
    tempRoots.push(root)
    const binary = join(root, 'fake-cursor-agent')
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
const evidence = {
  args,
  cwd: process.cwd(),
  home: process.env.HOME,
  cursorConfig: process.env.CURSOR_CONFIG_DIR,
  leakedKey: process.env.CURSOR_API_KEY || null,
  leakedToken: process.env.CURSOR_AUTH_TOKEN || null
}
process.stderr.write('EVIDENCE:' + Buffer.from(JSON.stringify(evidence)).toString('base64') + '\\n')
if (args[0] === '--version') process.stdout.write('2026.07.16-899851b\\n')
else process.stdout.write('Options:\\n  -p, --print  Print\\n  --sandbox <mode>  Sandbox\\n\\nCommands:\\n  mcp  Manage MCP\\n')
`
    await fs.writeFile(binary, script, { mode: 0o700 })
    await fs.chmod(binary, 0o700)
    const surfaces = await runBoundedCursorInventoryProbes(binary, {
      sourceEnvironment: {
        PATH: process.env.PATH,
        CURSOR_API_KEY: 'must-not-leak',
        CURSOR_AUTH_TOKEN: 'must-not-leak'
      }
    })
    const evidence = [surfaces.version, surfaces.help].map((item) => {
      const encoded = item.stderr.match(/EVIDENCE:([^\n]+)/)?.[1]
      if (!encoded) throw new Error('missing probe evidence')
      return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
        cwd: string
        home: string
        cursorConfig: string
        leakedKey: string | null
        leakedToken: string | null
      }
    })
    expect(evidence.map((item) => item.cwd)).toHaveLength(2)
    expect(new Set(evidence.map((item) => item.cwd)).size).toBe(2)
    for (const item of evidence) {
      expect(item.leakedKey).toBeNull()
      expect(item.leakedToken).toBeNull()
      expect(item.cwd).not.toBe(root)
      expect(item.home).not.toBe(process.env.HOME)
      expect(item.cursorConfig).not.toBe(process.env.CURSOR_CONFIG_DIR)
      expect(existsSync(item.cwd)).toBe(false)
      expect(existsSync(item.home)).toBe(false)
    }
  }, 15_000)
})

describe('Cursor release-manifest projection', () => {
  function manifestEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...qualification(),
      distribution: 'cursor-official-install',
      harnessNodeVersion: process.version,
      authentication: 'cursor-explicit-environment-token',
      backendBaseUrl: 'https://api2.cursor.sh',
      modelAlias: 'composer-2.5-fast',
      model: 'composer-2.5-fast',
      ...overrides
    }
  }

  it('projects every exact release field and verifies the embedded roster byte-semantically', () => {
    const manifest = { schemaVersion: 1, providers: { cursor: [manifestEntry()] } }
    const projected = projectCursorRuntimeQualificationsFromManifest(manifest)
    expect(projected.errors).toEqual([])
    expect(projected.qualifications).toEqual([qualification()])
    expect(projected.qualifications[0]).not.toHaveProperty('distribution')
    expect(projected.qualifications[0]).not.toHaveProperty('authentication')
    expect(projected.qualifications[0]).not.toHaveProperty('backendBaseUrl')
    expect(projected.qualifications[0]).not.toHaveProperty('modelAlias')
    expect(projected.qualifications[0]).not.toHaveProperty('model')
    expect(
      verifyEmbeddedCursorRuntimeQualificationProjection(manifest, projected.qualifications)
    ).toEqual({ ok: true, errors: [] })
    expect(verifyEmbeddedCursorRuntimeQualificationProjection(manifest, [])).toEqual({
      ok: false,
      errors: ['embedded Cursor runtime qualifications do not exactly match the release manifest']
    })
  })

  it('accepts the intentionally empty release/runtime projection', () => {
    expect(
      verifyEmbeddedCursorRuntimeQualificationProjection(
        { schemaVersion: 1, providers: { cursor: [] } },
        []
      )
    ).toEqual({ ok: true, errors: [] })
  })

  it('blocks partial, malformed, and wrong-posture manifest entries', () => {
    expect(
      projectCursorRuntimeQualificationsFromManifest({
        schemaVersion: 1,
        providers: { cursor: [{}] }
      }).errors.length
    ).toBeGreaterThan(0)
    expect(
      projectCursorRuntimeQualificationsFromManifest({
        schemaVersion: 1,
        providers: { cursor: [manifestEntry({ postureVersion: 'legacy' })] }
      }).errors
    ).toContain('providers.cursor qualification[0].postureVersion is not the production posture')
    expect(verifyEmbeddedCursorRuntimeQualificationProjection(null, [])).toMatchObject({
      ok: false
    })
  })
})
