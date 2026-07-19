import { createHash } from 'crypto'
import { createRequire } from 'module'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../../shared/kimiAcpPosture'
import {
  captureKimiBinaryIdentity,
  fingerprintKimiCapability,
  KIMI_RUNTIME_ATTESTATION_SOURCE,
  KIMI_RUNTIME_QUALIFICATION_SCOPE,
  KIMI_UNATTESTED_DEVELOPMENT_SOURCE,
  KimiRuntimeAdmissionGate,
  projectKimiCapability,
  projectKimiRuntimeQualificationsFromManifest,
  runBoundedKimiInventoryProbes,
  sameKimiBinaryIdentity,
  verifyEmbeddedKimiRuntimeQualificationProjection,
  type KimiBinaryIdentity,
  type KimiBinaryStatIdentity,
  type KimiInventorySurfaces,
  type KimiProbeCapture,
  type KimiRuntimeQualification
} from './KimiRuntimeAdmission'

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

function statIdentity(seed = '1'): KimiBinaryStatIdentity {
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

function binaryIdentity(digest = sha('a'), seed = '1'): KimiBinaryIdentity {
  return { realPath: '/real/kimi', sha256: digest, stat: statIdentity(seed) }
}

function capture(
  args: readonly string[],
  stdout: string,
  overrides: Partial<KimiProbeCapture> = {}
): KimiProbeCapture {
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

function inventorySurfaces(): KimiInventorySurfaces {
  return {
    version: capture(['--version'], 'Kimi Code 1.2.3\n'),
    help: capture(
      ['--help'],
      [
        'Usage: kimi [OPTIONS] [COMMAND]',
        '',
        'Options:',
        '  --quiet  Quiet',
        '',
        'Commands:',
        '  acp  Start ACP',
        ''
      ].join('\n')
    ),
    acpHelp: capture(
      ['acp', '--help'],
      ['Usage: kimi acp [OPTIONS]', '', 'Options:', '  --stdio  Use stdio', ''].join('\n')
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
    binaryPath: '/candidate/kimi',
    isPackaged: true,
    ...overrides
  }
}

function qualification(
  surfaces = inventorySurfaces(),
  overrides: Partial<KimiRuntimeQualification> = {}
): KimiRuntimeQualification {
  const capability = projectKimiCapability('1.2.3', surfaces)
  return {
    binarySha256: sha('a'),
    platform: process.platform,
    arch: process.arch,
    scope: KIMI_RUNTIME_QUALIFICATION_SCOPE,
    version: '1.2.3',
    capabilityFingerprint: fingerprintKimiCapability(capability),
    postureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION,
    attestationSource: KIMI_RUNTIME_ATTESTATION_SOURCE,
    ...overrides
  }
}

describe('Kimi runtime admission ordering and exact qualification', () => {
  it('blocks an empty roster and unknown SHA without executing the binary', async () => {
    const probeSurfaces = vi.fn(async () => inventorySurfaces())
    const gate = new KimiRuntimeAdmissionGate([], {
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
    const gate = new KimiRuntimeAdmissionGate(
      [{ binarySha256: '', scope: KIMI_RUNTIME_QUALIFICATION_SCOPE }],
      { captureIdentity, probeSurfaces }
    )

    await expect(gate.admit(admissionInput())).resolves.toMatchObject({
      admitted: false,
      reason: 'invalid_qualification_roster'
    })
    expect(captureIdentity).not.toHaveBeenCalled()
    expect(probeSurfaces).not.toHaveBeenCalled()
  })

  it('hashes first, probes a known SHA, revalidates identity, and returns a branded realpath', async () => {
    const identity = binaryIdentity()
    const captureIdentity = vi.fn(async () => identity)
    const probeSurfaces = vi.fn(async () => inventorySurfaces())
    const gate = new KimiRuntimeAdmissionGate([qualification()], {
      captureIdentity,
      probeSurfaces
    })

    const decision = await gate.admit(admissionInput())
    expect(decision).toMatchObject({
      admitted: true,
      binaryPath: '/real/kimi',
      mode: 'reviewed',
      qualification: { version: '1.2.3', scope: KIMI_RUNTIME_QUALIFICATION_SCOPE }
    })
    expect(captureIdentity).toHaveBeenCalledTimes(2)
    expect(probeSurfaces).toHaveBeenCalledTimes(1)
    expect(captureIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      probeSurfaces.mock.invocationCallOrder[0]
    )
    if (!decision.admitted) throw new Error('expected admission')
    await expect(decision.assertReadyForSpawn()).resolves.toBe('/real/kimi')
    expect(captureIdentity).toHaveBeenCalledTimes(3)
  })

  it('blocks exact version/capability drift even when the binary SHA is known', async () => {
    const gate = new KimiRuntimeAdmissionGate(
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
      .fn<() => Promise<KimiBinaryIdentity>>()
      .mockResolvedValueOnce(binaryIdentity())
      .mockResolvedValueOnce(binaryIdentity(sha('b'), '2'))
    const gate = new KimiRuntimeAdmissionGate([qualification()], {
      captureIdentity,
      probeSurfaces: async () => inventorySurfaces()
    })
    await expect(gate.admit(admissionInput())).resolves.toMatchObject({
      admitted: false,
      reason: 'binary_identity_changed'
    })
  })

  it('runs the known identity probe as a single flight for concurrent callers', async () => {
    let releaseProbe: (surfaces: KimiInventorySurfaces) => void = () => {
      throw new Error('probe did not start')
    }
    const probeSurfaces = vi.fn(
      () =>
        new Promise<KimiInventorySurfaces>((resolve) => {
          releaseProbe = resolve
        })
    )
    const gate = new KimiRuntimeAdmissionGate([qualification()], {
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
    const gate = new KimiRuntimeAdmissionGate([], {
      captureIdentity: async () => binaryIdentity(),
      probeSurfaces
    })
    await expect(
      gate.admit(
        admissionInput({
          isPackaged: true,
          environment: { TASKWRAITH_ALLOW_UNATTESTED_KIMI_DEV: '1' }
        })
      )
    ).resolves.toMatchObject({ admitted: false, reason: 'unknown_binary' })
    await expect(
      gate.admit(
        admissionInput({
          isPackaged: false,
          environment: { TASKWRAITH_ALLOW_UNATTESTED_KIMI_DEV: 'true' }
        })
      )
    ).resolves.toMatchObject({ admitted: false, reason: 'unknown_binary' })
    await expect(
      gate.admit(
        admissionInput({
          isPackaged: false,
          environment: { TASKWRAITH_ALLOW_UNATTESTED_KIMI_DEV: '1' }
        })
      )
    ).resolves.toMatchObject({
      admitted: true,
      mode: 'unattested-development',
      qualification: null,
      attestationSource: KIMI_UNATTESTED_DEVELOPMENT_SOURCE
    })
    expect(probeSurfaces).toHaveBeenCalledTimes(1)
  })

  it('uses the exact same canonical capability fingerprint as the release canary', () => {
    const projection = projectKimiCapability('1.2.3', inventorySurfaces())
    expect(fingerprintKimiCapability(projection)).toBe(canary.capabilityFingerprint(projection))
  })
})

describe('Kimi binary identity and bounded inventory roots', () => {
  it('binds the digest to realpath plus bigint file identity', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'taskwraith-kimi-identity-test-'))
    tempRoots.push(root)
    const binary = join(root, 'kimi')
    await fs.writeFile(binary, 'known bytes', { mode: 0o700 })
    const first = await captureKimiBinaryIdentity(binary)
    expect(first.sha256).toBe(`sha256:${createHash('sha256').update('known bytes').digest('hex')}`)
    expect(first.realPath).toBe(await fs.realpath(binary))
    expect(Object.values(first.stat).every((value) => typeof value === 'string')).toBe(true)

    await fs.writeFile(binary, 'changed bytes', { mode: 0o700 })
    const second = await captureKimiBinaryIdentity(binary)
    expect(sameKimiBinaryIdentity(first, second)).toBe(false)
  })

  it('uses three distinct scrubbed synthetic homes/cwds and removes them', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'taskwraith-kimi-probe-test-'))
    tempRoots.push(root)
    const binary = join(root, 'fake-kimi')
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
const evidence = {
  args,
  cwd: process.cwd(),
  home: process.env.HOME,
  kimiHome: process.env.KIMI_CODE_HOME,
  leaked: process.env.ADMISSION_TEST_SECRET || null
}
process.stderr.write('EVIDENCE:' + Buffer.from(JSON.stringify(evidence)).toString('base64') + '\\n')
if (args[0] === '--version') process.stdout.write('Kimi Code 1.2.3\\n')
else if (args[0] === '--help') process.stdout.write('Options:\\n  --quiet  Quiet\\n\\nCommands:\\n  acp  Start ACP\\n')
else process.stdout.write('Options:\\n  --stdio  Use stdio\\n')
`
    await fs.writeFile(binary, script, { mode: 0o700 })
    await fs.chmod(binary, 0o700)
    const surfaces = await runBoundedKimiInventoryProbes(binary, {
      sourceEnvironment: { PATH: process.env.PATH, ADMISSION_TEST_SECRET: 'must-not-leak' }
    })
    const evidence = [surfaces.version, surfaces.help, surfaces.acpHelp].map((item) => {
      const encoded = item.stderr.match(/EVIDENCE:([^\n]+)/)?.[1]
      if (!encoded) throw new Error('missing probe evidence')
      return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
        cwd: string
        home: string
        kimiHome: string
        leaked: string | null
      }
    })
    expect(evidence.map((item) => item.cwd)).toHaveLength(3)
    expect(new Set(evidence.map((item) => item.cwd)).size).toBe(3)
    for (const item of evidence) {
      expect(item.leaked).toBeNull()
      expect(item.cwd).not.toBe(root)
      expect(item.home).not.toBe(process.env.HOME)
      expect(item.kimiHome).not.toBe(process.env.KIMI_CODE_HOME)
      expect(existsSync(item.cwd)).toBe(false)
      expect(existsSync(item.home)).toBe(false)
      expect(existsSync(item.kimiHome)).toBe(false)
    }
  }, 15_000)
})

describe('Kimi release-manifest projection', () => {
  function manifestEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...qualification(),
      distribution: 'official-checksummed-standalone',
      harnessNodeVersion: process.version,
      authentication: 'kimi-code-provider-api-key',
      backendBaseUrl: 'https://api.kimi.com/coding/v1',
      modelAlias: 'kimi-for-coding',
      model: 'kimi-for-coding',
      ...overrides
    }
  }

  it('projects every exact release field and verifies the embedded roster byte-semantically', () => {
    const manifest = { schemaVersion: 1, providers: { kimi: [manifestEntry()] } }
    const projected = projectKimiRuntimeQualificationsFromManifest(manifest)
    expect(projected.errors).toEqual([])
    expect(projected.qualifications).toEqual([qualification()])
    expect(projected.qualifications[0]).not.toHaveProperty('distribution')
    expect(projected.qualifications[0]).not.toHaveProperty('authentication')
    expect(projected.qualifications[0]).not.toHaveProperty('backendBaseUrl')
    expect(projected.qualifications[0]).not.toHaveProperty('modelAlias')
    expect(projected.qualifications[0]).not.toHaveProperty('model')
    expect(
      verifyEmbeddedKimiRuntimeQualificationProjection(manifest, projected.qualifications)
    ).toEqual({ ok: true, errors: [] })
    expect(verifyEmbeddedKimiRuntimeQualificationProjection(manifest, [])).toEqual({
      ok: false,
      errors: ['embedded Kimi runtime qualifications do not exactly match the release manifest']
    })
  })

  it('accepts the intentionally empty release/runtime projection', () => {
    expect(
      verifyEmbeddedKimiRuntimeQualificationProjection(
        { schemaVersion: 1, providers: { kimi: [] } },
        []
      )
    ).toEqual({ ok: true, errors: [] })
  })

  it('blocks partial, malformed, and wrong-posture manifest entries', () => {
    expect(
      projectKimiRuntimeQualificationsFromManifest({ schemaVersion: 1, providers: { kimi: [{}] } })
        .errors.length
    ).toBeGreaterThan(0)
    expect(
      projectKimiRuntimeQualificationsFromManifest({
        schemaVersion: 1,
        providers: { kimi: [manifestEntry({ postureVersion: 'legacy' })] }
      }).errors
    ).toContain('providers.kimi qualification[0].postureVersion is not the production posture')
    expect(verifyEmbeddedKimiRuntimeQualificationProjection(null, [])).toMatchObject({ ok: false })
  })
})
