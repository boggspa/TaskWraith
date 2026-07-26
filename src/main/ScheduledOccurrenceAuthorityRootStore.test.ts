import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCHEDULED_OCCURRENCE_AUTHORITY_ROOT_FILENAME,
  ScheduledOccurrenceAuthorityRootStore,
  type ScheduledOccurrenceAuthoritySafeStorage
} from './ScheduledOccurrenceAuthorityRootStore'

const PURPOSE = 'taskwraith:scheduled-occurrence-authority-root:v1'
const LOCK_PURPOSE = 'taskwraith:scheduled-occurrence-authority-root-initialization:v1'
const LOCK_FILENAME = 'scheduled-occurrence-authority-root.lock'
const CREATED_AT = '2026-07-15T04:30:00.000Z'
const LEGACY_WORKSPACE_PATH = resolve(tmpdir(), 'tw-legacy-workspace')
const FIFO_CHILD_USER_DATA = 'TASKWRAITH_AUTHORITY_ROOT_FIFO_CHILD_USER_DATA'
const dirs: string[] = []
const platformRestorers: Array<() => void> = []

function tempUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tw-occurrence-authority-'))
  dirs.push(directory)
  return directory
}

function xorCipher(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0xa5))
}

const secureStorage: ScheduledOccurrenceAuthoritySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => xorCipher(Buffer.from(plaintext, 'utf8')),
  decryptString: (ciphertext) => xorCipher(ciphertext).toString('utf8'),
  getSelectedStorageBackend: () => 'kwallet6'
}

function store(
  userDataPath: string,
  safeStorage: ScheduledOccurrenceAuthoritySafeStorage = secureStorage
): ScheduledOccurrenceAuthorityRootStore {
  return new ScheduledOccurrenceAuthorityRootStore({ userDataPath, safeStorage })
}

function emulateProcessPlatform(platform: NodeJS.Platform): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor?.configurable) {
    throw new Error('process.platform is not configurable in this Node test runtime')
  }
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: descriptor.enumerable,
    value: platform
  })
  platformRestorers.push(() => Object.defineProperty(process, 'platform', descriptor))
}

function authorityPath(userDataPath: string): string {
  return join(userDataPath, SCHEDULED_OCCURRENCE_AUTHORITY_ROOT_FILENAME)
}

function lockPath(userDataPath: string): string {
  return join(userDataPath, LOCK_FILENAME)
}

function lockRecord(pid: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    purpose: LOCK_PURPOSE,
    pid,
    createdAt: CREATED_AT,
    nonce: Buffer.alloc(16, 7).toString('base64')
  }
}

function actualLockSnapshot(path: string): { kind: 'symlink' | 'file'; value: string } {
  const stat = lstatSync(path)
  return stat.isSymbolicLink()
    ? { kind: 'symlink', value: readlinkSync(path) }
    : { kind: 'file', value: readFileSync(path, 'utf8') }
}

function rootIdFor(root: Buffer): string {
  return `twso-root-v1:${createHash('sha256').update(root).digest('hex')}`
}

function persistedRoot(
  root: Buffer,
  safeStorage: ScheduledOccurrenceAuthoritySafeStorage = secureStorage,
  overrides: Partial<{
    schemaVersion: number
    rootId: string
    createdAt: string
    encryptedRoot: string
  }> = {},
  innerOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const rootId = rootIdFor(root)
  const inner = {
    schemaVersion: 1,
    purpose: PURPOSE,
    rootId,
    rootKeyBase64: root.toString('base64'),
    ...innerOverrides
  }
  return {
    schemaVersion: 1,
    rootId,
    createdAt: CREATED_AT,
    encryptedRoot: safeStorage.encryptString(JSON.stringify(inner)).toString('base64'),
    ...overrides
  }
}

function writePersistedRoot(
  userDataPath: string,
  root: Buffer,
  safeStorage: ScheduledOccurrenceAuthoritySafeStorage = secureStorage
): void {
  writeFileSync(
    authorityPath(userDataPath),
    JSON.stringify(persistedRoot(root, safeStorage)) + '\n',
    { mode: 0o600 }
  )
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value))
}

function legacySeal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    issuedAt: CREATED_AT,
    taskAuthorityDigest: '1'.repeat(64),
    compositeWorkflowAuthorityDigest: null,
    workspaceRealPath: LEGACY_WORKSPACE_PATH,
    runtimeProfileSetHmac: '2'.repeat(64),
    permissionPostureSetHmac: '3'.repeat(64),
    sealSignature: '4'.repeat(64),
    ...overrides
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const restore of platformRestorers.splice(0).reverse()) restore()
  for (const directory of dirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32' || !process.env[FIFO_CHILD_USER_DATA])(
  'FIFO child process probe rejects the root without blocking',
  () => {
    expect(() => store(process.env[FIFO_CHILD_USER_DATA] as string).loadOrCreate()).toThrow(
      /not a regular file/
    )
  }
)

describe('ScheduledOccurrenceAuthorityRootStore', () => {
  it('creates one durable root and reloads the same fixed-domain authority', () => {
    const userDataPath = tempUserData()
    const first = store(userDataPath).loadOrCreate()
    const second = store(userDataPath).loadOrCreate()
    const payload = Buffer.from('canonical authority payload')

    expect(first.rootId).toBe(second.rootId)
    expect(first.rootId).toMatch(/^twso-root-v1:[a-f0-9]{64}$/)
    expect(second.sealPayloadMac(payload)).toBe(first.sealPayloadMac(payload))
    expect(second.walPayloadMac(payload)).toBe(first.walPayloadMac(payload))
    expect(second.runtimeProfileSetHmac(payload)).toBe(first.runtimeProfileSetHmac(payload))
    expect(second.permissionPostureSetHmac(payload)).toBe(first.permissionPostureSetHmac(payload))
    expect(second.providerLaunchHmac('claude', payload)).toBe(
      first.providerLaunchHmac('claude', payload)
    )

    const outputs = new Set([
      first.sealPayloadMac(payload),
      first.walPayloadMac(payload),
      first.runtimeProfileSetHmac(payload),
      first.permissionPostureSetHmac(payload),
      first.providerLaunchHmac('claude', payload)
    ])
    expect(outputs.size).toBe(5)
    expect([...outputs].every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true)
    expect(first.verifySealPayloadMac(payload, first.sealPayloadMac(payload))).toBe(true)
    expect(first.verifyWalPayloadMac(payload, first.walPayloadMac(payload))).toBe(true)
    expect(first.verifySealPayloadMac(Buffer.from('different'), first.sealPayloadMac(payload))).toBe(
      false
    )
    expect(first.verifyWalPayloadMac(payload, first.sealPayloadMac(payload))).toBe(false)
    expect(first.verifySealPayloadMac(payload, first.sealPayloadMac(payload).toUpperCase())).toBe(
      false
    )

    first.dispose()
    second.dispose()
  })

  it('persists only the exact encrypted envelope, mode 0600, with no temporary file', () => {
    const userDataPath = tempUserData()
    const authority = store(userDataPath).loadOrCreate()
    const path = authorityPath(userDataPath)
    const raw = readFileSync(path, 'utf8')
    const outer = JSON.parse(raw) as Record<string, unknown>

    expect(Object.keys(outer).sort()).toEqual(
      ['schemaVersion', 'rootId', 'createdAt', 'encryptedRoot'].sort()
    )
    expect(outer).toMatchObject({ schemaVersion: 1, rootId: authority.rootId })
    expect(new Date(String(outer.createdAt)).toISOString()).toBe(outer.createdAt)
    expect(raw).not.toContain(PURPOSE)
    expect(raw).not.toContain('rootKeyBase64')

    const innerPlaintext = secureStorage.decryptString(
      Buffer.from(String(outer.encryptedRoot), 'base64')
    )
    const inner = JSON.parse(innerPlaintext) as Record<string, unknown>
    expect(Object.keys(inner).sort()).toEqual(
      ['schemaVersion', 'purpose', 'rootId', 'rootKeyBase64'].sort()
    )
    expect(inner).toMatchObject({ schemaVersion: 1, purpose: PURPOSE, rootId: authority.rootId })
    expect(Buffer.from(String(inner.rootKeyBase64), 'base64')).toHaveLength(32)
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
    expect(readdirSync(userDataPath).filter((entry) => entry.endsWith('.tmp'))).toEqual([])

    authority.dispose()
  })

  it('does not adopt an unproven root that appears under its owned initialization lock', () => {
    const userDataPath = tempUserData()
    const winner = randomBytes(32)
    let installedWinner = false
    const racingStorage: ScheduledOccurrenceAuthoritySafeStorage = {
      ...secureStorage,
      encryptString: (plaintext) => {
        if (!installedWinner) {
          installedWinner = true
          writePersistedRoot(userDataPath, winner, secureStorage)
        }
        return secureStorage.encryptString(plaintext)
      }
    }

    expect(() => store(userDataPath, racingStorage).loadOrCreate()).toThrow(
      /unproven authority root won publication/
    )
    expect(JSON.parse(readFileSync(authorityPath(userDataPath), 'utf8'))).toMatchObject({
      rootId: rootIdFor(winner)
    })
    expect(existsSync(lockPath(userDataPath))).toBe(true)
    expect(readdirSync(userDataPath).filter((entry) => entry.endsWith('.tmp'))).toEqual([])

    winner.fill(0)
  })

  it('blocks every pre-existing initialization lock without automatic stale recovery', () => {
    const activeUserDataPath = tempUserData()
    writeJson(lockPath(activeUserDataPath), lockRecord(process.pid))
    expect(() => store(activeUserDataPath).loadOrCreate()).toThrow(
      /initialization lock already exists/
    )
    expect(existsSync(authorityPath(activeUserDataPath))).toBe(false)
    expect(existsSync(lockPath(activeUserDataPath))).toBe(true)

    const staleUserDataPath = tempUserData()
    writeJson(lockPath(staleUserDataPath), lockRecord(2_147_483_647))
    expect(() => store(staleUserDataPath).loadOrCreate()).toThrow(
      /automatic stale-lock recovery/
    )
    expect(existsSync(authorityPath(staleUserDataPath))).toBe(false)
    expect(readFileSync(lockPath(staleUserDataPath), 'utf8')).toBe(
      JSON.stringify(lockRecord(2_147_483_647))
    )
  })

  it('fails closed on malformed or non-regular initialization locks', () => {
    const malformedUserDataPath = tempUserData()
    writeJson(lockPath(malformedUserDataPath), { ...lockRecord(process.pid), extra: true })
    expect(() => store(malformedUserDataPath).loadOrCreate()).toThrow(
      /initialization lock already exists/
    )
    expect(existsSync(authorityPath(malformedUserDataPath))).toBe(false)
    expect(existsSync(lockPath(malformedUserDataPath))).toBe(true)

    if (process.platform !== 'win32') {
      const symlinkUserDataPath = tempUserData()
      const target = join(symlinkUserDataPath, 'lock-target.json')
      writeJson(target, lockRecord(process.pid))
      symlinkSync(target, lockPath(symlinkUserDataPath))
      expect(() => store(symlinkUserDataPath).loadOrCreate()).toThrow(
        /initialization lock already exists/
      )
      expect(existsSync(authorityPath(symlinkUserDataPath))).toBe(false)
    }
  })

  it('blocks a visible root behind any leftover initialization lock without touching either', () => {
    const cases: Array<{
      name: string
      installLock: (userDataPath: string) => void
    }> = [
      {
        name: 'live',
        installLock: (userDataPath) => writeJson(lockPath(userDataPath), lockRecord(process.pid))
      },
      {
        name: 'stale',
        installLock: (userDataPath) =>
          writeJson(lockPath(userDataPath), lockRecord(2_147_483_647))
      },
      {
        name: 'malformed',
        installLock: (userDataPath) => writeFileSync(lockPath(userDataPath), '{bad lock')
      }
    ]
    if (process.platform !== 'win32') {
      cases.push({
        name: 'symlink',
        installLock: (userDataPath) => {
          const target = join(userDataPath, 'committed-root-lock-target.json')
          writeJson(target, lockRecord(process.pid))
          symlinkSync(target, lockPath(userDataPath))
        }
      })
    }

    for (const testCase of cases) {
      const userDataPath = tempUserData()
      const root = randomBytes(32)
      writePersistedRoot(userDataPath, root)
      testCase.installLock(userDataPath)
      const lockStatBefore = actualLockSnapshot(lockPath(userDataPath))

      expect(() => store(userDataPath).loadOrCreate(), testCase.name).toThrow(/root is not ready/)
      expect(JSON.parse(readFileSync(authorityPath(userDataPath), 'utf8')), testCase.name).toMatchObject({
        rootId: rootIdFor(root)
      })
      expect(actualLockSnapshot(lockPath(userDataPath)), testCase.name).toEqual(lockStatBefore)
      root.fill(0)
    }
  })

  it('revalidates after safeStorage callbacks before publishing the candidate root', () => {
    const userDataPath = tempUserData()
    let injected = false
    const injectingStorage: ScheduledOccurrenceAuthoritySafeStorage = {
      ...secureStorage,
      encryptString: (plaintext) => {
        if (!injected) {
          injected = true
          writeJson(join(userDataPath, 'scheduled-tasks.json'), [
            { id: 'late-v2', occurrenceSeal: legacySeal({ schemaVersion: 2 }) }
          ])
        }
        return secureStorage.encryptString(plaintext)
      }
    }

    expect(() => store(userDataPath, injectingStorage).loadOrCreate()).toThrow(
      /unsupported or malformed occurrenceSeal/
    )
    expect(injected).toBe(true)
    expect(existsSync(authorityPath(userDataPath))).toBe(false)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
  })

  it('zeroizes and disables its closure-backed key on dispose', () => {
    const authority = store(tempUserData()).loadOrCreate()
    const payload = Buffer.from('payload')
    const rootId = authority.rootId
    const exposedKeys = Object.keys(authority).sort()
    expect(exposedKeys).toEqual(
      [
        'rootId',
        'sealPayloadMac',
        'verifySealPayloadMac',
        'walPayloadMac',
        'verifyWalPayloadMac',
        'runtimeProfileSetHmac',
        'permissionPostureSetHmac',
        'providerLaunchHmac',
        'verifyProviderLaunchHmac',
        'dispose'
      ].sort()
    )
    expect(exposedKeys).not.toContain('key')
    expect(exposedKeys).not.toContain('derive')

    authority.dispose()
    authority.dispose()
    expect(authority.rootId).toBe(rootId)
    expect(() => authority.sealPayloadMac(payload)).toThrow(/disposed/)
    expect(() => authority.verifySealPayloadMac(payload, '0'.repeat(64))).toThrow(/disposed/)
    expect(() => authority.walPayloadMac(payload)).toThrow(/disposed/)
    expect(() => authority.verifyWalPayloadMac(payload, '0'.repeat(64))).toThrow(/disposed/)
    expect(() => authority.runtimeProfileSetHmac(payload)).toThrow(/disposed/)
    expect(() => authority.permissionPostureSetHmac(payload)).toThrow(/disposed/)
    expect(() => authority.providerLaunchHmac('claude', payload)).toThrow(/disposed/)
    expect(() =>
      authority.verifyProviderLaunchHmac('claude', payload, '0'.repeat(64))
    ).toThrow(/disposed/)
  })

  it('requires Buffer payloads and treats malformed MACs as verification failures', () => {
    const authority = store(tempUserData()).loadOrCreate()
    expect(() => authority.sealPayloadMac('payload' as unknown as Buffer)).toThrow(/Buffer/)
    expect(authority.verifySealPayloadMac(Buffer.from('payload'), '')).toBe(false)
    expect(authority.verifySealPayloadMac(Buffer.from('payload'), 'g'.repeat(64))).toBe(false)
    authority.dispose()
  })

  it('brands provider launch authority and rejects cross-provider verification', () => {
    const authority = store(tempUserData()).loadOrCreate()
    const payload = Buffer.from('{"canonical":"launch"}')
    const claude = authority.providerLaunchHmac('claude', payload)
    const codex = authority.providerLaunchHmac('codex', payload)
    const pi = authority.providerLaunchHmac('pi', payload)
    const antigravity = authority.providerLaunchHmac('antigravity', payload)

    expect(claude).not.toBe(codex)
    expect(pi).not.toBe(antigravity)
    expect(pi).not.toBe(codex)
    expect(authority.verifyProviderLaunchHmac('claude', payload, claude)).toBe(true)
    expect(authority.verifyProviderLaunchHmac('codex', payload, claude)).toBe(false)
    expect(authority.verifyProviderLaunchHmac('claude', payload, codex)).toBe(false)
    expect(authority.verifyProviderLaunchHmac('pi', payload, pi)).toBe(true)
    expect(authority.verifyProviderLaunchHmac('antigravity', payload, antigravity)).toBe(true)
    expect(authority.verifyProviderLaunchHmac('antigravity', payload, pi)).toBe(false)
    expect(authority.verifyProviderLaunchHmac('pi', payload, antigravity)).toBe(false)
    expect(() =>
      authority.providerLaunchHmac('gemini' as unknown as 'claude', payload)
    ).toThrow(/runnable provider/)
    expect(() =>
      authority.providerLaunchHmac('Claude' as unknown as 'claude', payload)
    ).toThrow(/runnable provider/)
    authority.dispose()
  })

  it('never regenerates an existing corrupt or schema-mismatched envelope', () => {
    const userDataPath = tempUserData()
    const path = authorityPath(userDataPath)
    const encryptString = vi.fn(secureStorage.encryptString)
    const monitoredStorage = { ...secureStorage, encryptString }

    writeFileSync(path, '{not json', { mode: 0o600 })
    expect(() => store(userDataPath, monitoredStorage).loadOrCreate()).toThrow(
      /exists but cannot be read|refusing to replace/i
    )
    expect(encryptString).not.toHaveBeenCalled()

    writeJson(path, { ...persistedRoot(randomBytes(32)), unexpected: true })
    expect(() => store(userDataPath, monitoredStorage).loadOrCreate()).toThrow(/exact schema/)
    expect(encryptString).not.toHaveBeenCalled()
  })

  it('rejects an oversized sparse root before decryption and does not create a lock', () => {
    const userDataPath = tempUserData()
    const path = authorityPath(userDataPath)
    writeFileSync(path, '', { mode: 0o600 })
    truncateSync(path, 64 * 1024 + 1)
    const decryptString = vi.fn(secureStorage.decryptString)

    expect(() =>
      store(userDataPath, { ...secureStorage, decryptString }).loadOrCreate()
    ).toThrow(/exceeds the 65536-byte authority read limit/)
    expect(decryptString).not.toHaveBeenCalled()
    expect(statSync(path).size).toBe(64 * 1024 + 1)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
  })

  it('never regenerates when existing root decryption fails or root identity mismatches', () => {
    const userDataPath = tempUserData()
    const path = authorityPath(userDataPath)
    const root = randomBytes(32)
    writeJson(path, persistedRoot(root))
    const encryptString = vi.fn(secureStorage.encryptString)
    const failedDecrypt: ScheduledOccurrenceAuthoritySafeStorage = {
      ...secureStorage,
      encryptString,
      decryptString: () => {
        throw new Error('login keychain changed')
      }
    }
    expect(() => store(userDataPath, failedDecrypt).loadOrCreate()).toThrow(
      /cannot be decrypted or verified|login keychain changed/
    )
    expect(encryptString).not.toHaveBeenCalled()

    writeJson(path, persistedRoot(root, secureStorage, { rootId: `twso-root-v1:${'0'.repeat(64)}` }))
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/rootId does not match/)
    root.fill(0)
  })

  it('returns no closure when the persisted root changes during safeStorage decryption', () => {
    const userDataPath = tempUserData()
    const original = randomBytes(32)
    const replacement = randomBytes(32)
    writePersistedRoot(userDataPath, original)
    let swapped = false
    const swappingStorage: ScheduledOccurrenceAuthoritySafeStorage = {
      ...secureStorage,
      decryptString: (ciphertext) => {
        if (!swapped) {
          swapped = true
          writePersistedRoot(userDataPath, replacement)
        }
        return secureStorage.decryptString(ciphertext)
      }
    }

    expect(() => store(userDataPath, swappingStorage).loadOrCreate()).toThrow(
      /persisted authority root changed while it was being loaded/
    )
    expect(existsSync(lockPath(userDataPath))).toBe(false)
    const recovered = store(userDataPath).loadOrCreate()
    expect(recovered.rootId).toBe(rootIdFor(replacement))
    recovered.dispose()
    original.fill(0)
    replacement.fill(0)
  })

  it.each([
    ['non-canonical encrypted base64', { encryptedRoot: 'YWJjZA' }],
    ['non-canonical createdAt', { createdAt: '2026-07-15T04:30:00Z' }],
    ['unknown outer schema', { schemaVersion: 2 }],
    ['malformed rootId', { rootId: 'root-id' }]
  ])('rejects an existing envelope with %s', (_label, override) => {
    const userDataPath = tempUserData()
    writeJson(authorityPath(userDataPath), persistedRoot(randomBytes(32), secureStorage, override))
    expect(() => store(userDataPath).loadOrCreate()).toThrow()
  })

  it.each([
    ['an extra field', { unexpected: true }],
    ['a wrong purpose', { purpose: 'another-purpose' }],
    ['a short root', { rootKeyBase64: Buffer.alloc(31).toString('base64') }],
    ['non-canonical base64', { rootKeyBase64: 'YWJjZA' }],
    ['an unknown schema', { schemaVersion: 2 }]
  ])('rejects an encrypted inner root with %s', (_label, innerOverride) => {
    const userDataPath = tempUserData()
    const root = randomBytes(32)
    writeJson(authorityPath(userDataPath), persistedRoot(root, secureStorage, {}, innerOverride))
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/cannot be decrypted or verified/)
    root.fill(0)
  })

  it('refuses unavailable safeStorage and every non-allowlisted Linux backend', () => {
    const userDataPath = tempUserData()
    emulateProcessPlatform('linux')
    expect(() =>
      store(userDataPath, { ...secureStorage, isEncryptionAvailable: () => false }).loadOrCreate()
    ).toThrow(/safeStorage encryption is unavailable/)
    expect(existsSync(authorityPath(userDataPath))).toBe(false)

    for (const backend of ['basic_text', 'unknown', 'plaintext', ''] as const) {
      expect(() =>
        store(userDataPath, {
          ...secureStorage,
          getSelectedStorageBackend: () => backend
        }).loadOrCreate()
      ).toThrow(/unsupported Linux backend/)
      expect(existsSync(authorityPath(userDataPath))).toBe(false)
    }
    expect(() =>
      store(userDataPath, { ...secureStorage, getSelectedStorageBackend: undefined }).loadOrCreate()
    ).toThrow(/unsupported Linux backend unknown/)
  })

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'accepts the explicitly encrypted Linux safeStorage backend %s',
    (backend) => {
      emulateProcessPlatform('linux')
      const userDataPath = tempUserData()
      const root = randomBytes(32)
      writePersistedRoot(userDataPath, root)
      const authority = store(userDataPath, {
        ...secureStorage,
        getSelectedStorageBackend: () => backend
      }).loadOrCreate()
      expect(authority.rootId).toMatch(/^twso-root-v1:/)
      authority.dispose()
      root.fill(0)
    }
  )

  it('allows structurally valid unsealed data, exact legacy v1 seals, and a clean null WAL', () => {
    const userDataPath = tempUserData()
    writeJson(join(userDataPath, 'scheduled-tasks.json'), [
      { id: 'legacy-task', status: 'pending' },
      { id: 'sealed-v1-task', status: 'due', occurrenceSeal: legacySeal() }
    ])
    writeJson(join(userDataPath, 'scheduled-occurrence-mutation.json'), {
      schemaVersion: 1,
      taskBefore: {
        id: 'legacy-task',
        occurrenceSeal: legacySeal({ compositeWorkflowAuthorityDigest: '5'.repeat(64) })
      },
      taskAfter: { id: 'legacy-task', status: 'due', occurrenceSeal: legacySeal() },
      unrelatedLegacyField: true
    })

    const authority = store(userDataPath).loadOrCreate()
    expect(authority.rootId).toMatch(/^twso-root-v1:/)
    authority.dispose()

    const cleanUserDataPath = tempUserData()
    writeJson(join(cleanUserDataPath, 'scheduled-occurrence-mutation.json'), null)
    const cleanAuthority = store(cleanUserDataPath).loadOrCreate()
    expect(cleanAuthority.rootId).toMatch(/^twso-root-v1:/)
    cleanAuthority.dispose()
  })

  it.each([
    ['future v2 seal', legacySeal({ schemaVersion: 2 })],
    ['unknown seal', legacySeal({ schemaVersion: 99 })],
    ['malformed seal', 'not-an-object'],
    ['null seal', null],
    ['seal with an extra field', legacySeal({ extra: true })],
    ['seal with a missing field', { ...legacySeal(), sealSignature: undefined }],
    ['seal with a non-canonical timestamp', legacySeal({ issuedAt: '2026-07-15T04:30:00Z' })],
    ['seal with uppercase MAC data', legacySeal({ sealSignature: 'A'.repeat(64) })],
    ['seal with a relative path', legacySeal({ workspaceRealPath: 'workspace' })]
  ])('blocks root generation when a scheduled task contains %s', (_label, occurrenceSeal) => {
    const userDataPath = tempUserData()
    writeJson(join(userDataPath, 'scheduled-tasks.json'), [{ id: 'task', occurrenceSeal }])
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is missing.*occurrenceSeal/i)
    expect(existsSync(authorityPath(userDataPath))).toBe(false)
  })

  it.each([
    ['future v2 journal', { schemaVersion: 2, taskBefore: null, taskAfter: {} }],
    ['unknown journal', { schemaVersion: 99, taskBefore: null, taskAfter: {} }],
    ['missing before image', { schemaVersion: 1, taskAfter: {} }],
    ['missing after image', { schemaVersion: 1, taskBefore: null }],
    ['malformed before image', { schemaVersion: 1, taskBefore: 'task', taskAfter: {} }],
    [
      'sealed before image',
      { schemaVersion: 1, taskBefore: { occurrenceSeal: {} }, taskAfter: {} }
    ],
    [
      'sealed after image',
      { schemaVersion: 1, taskBefore: null, taskAfter: { occurrenceSeal: {} } }
    ],
    [
      'future v2 seal in before image',
      {
        schemaVersion: 1,
        taskBefore: { occurrenceSeal: legacySeal({ schemaVersion: 2 }) },
        taskAfter: {}
      }
    ],
    [
      'unknown seal in after image',
      {
        schemaVersion: 1,
        taskBefore: null,
        taskAfter: { occurrenceSeal: legacySeal({ schemaVersion: 99 }) }
      }
    ]
  ])('blocks root generation for %s', (_label, journal) => {
    const userDataPath = tempUserData()
    writeJson(join(userDataPath, 'scheduled-occurrence-mutation.json'), journal)
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is missing/i)
    expect(existsSync(authorityPath(userDataPath))).toBe(false)
  })

  it('blocks malformed artifact files rather than assuming they are authority-free', () => {
    const userDataPath = tempUserData()
    writeFileSync(join(userDataPath, 'scheduled-tasks.json'), '{bad json')
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/cannot be inspected/)
    writeJson(join(userDataPath, 'scheduled-tasks.json'), [])
    writeFileSync(join(userDataPath, 'scheduled-occurrence-mutation.json'), '{bad json')
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/cannot be inspected/)
    expect(existsSync(authorityPath(userDataPath))).toBe(false)
  })

  it.each(['scheduled-tasks.json', 'scheduled-occurrence-mutation.json'])(
    'rejects an oversized sparse %s before JSON parsing without root or lock mutation',
    (filename) => {
      const userDataPath = tempUserData()
      const path = join(userDataPath, filename)
      writeFileSync(path, '')
      truncateSync(path, 64 * 1024 * 1024 + 1)

      expect(() => store(userDataPath).loadOrCreate()).toThrow(
        /exceeds the 67108864-byte authority read limit/
      )
      expect(statSync(path).size).toBe(64 * 1024 * 1024 + 1)
      expect(existsSync(authorityPath(userDataPath))).toBe(false)
      expect(existsSync(lockPath(userDataPath))).toBe(false)
    }
  )

  it('rejects symlink and non-regular scheduling artifact paths before reading them', () => {
    if (process.platform !== 'win32') {
      const symlinkUserDataPath = tempUserData()
      const target = join(symlinkUserDataPath, 'legacy-tasks-target.json')
      writeJson(target, [])
      symlinkSync(target, join(symlinkUserDataPath, 'scheduled-tasks.json'))
      expect(() => store(symlinkUserDataPath).loadOrCreate()).toThrow(/cannot be inspected/)
      expect(existsSync(authorityPath(symlinkUserDataPath))).toBe(false)

      const danglingUserDataPath = tempUserData()
      symlinkSync(
        join(danglingUserDataPath, 'missing-target.json'),
        join(danglingUserDataPath, 'scheduled-tasks.json')
      )
      expect(() => store(danglingUserDataPath).loadOrCreate()).toThrow(/cannot be inspected/)
      expect(existsSync(authorityPath(danglingUserDataPath))).toBe(false)
    }

    const directoryUserDataPath = tempUserData()
    mkdirSync(join(directoryUserDataPath, 'scheduled-occurrence-mutation.json'))
    expect(() => store(directoryUserDataPath).loadOrCreate()).toThrow(/cannot be inspected/)
    expect(existsSync(authorityPath(directoryUserDataPath))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a root FIFO without blocking startup',
    () => {
      const userDataPath = tempUserData()
      const fifoPath = authorityPath(userDataPath)
      const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' })
      expect(mkfifo.status, mkfifo.stderr).toBe(0)

      const child = spawnSync(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/ScheduledOccurrenceAuthorityRootStore.test.ts',
          '--testNamePattern',
          'FIFO child process probe',
          '--reporter=dot'
        ],
        {
          encoding: 'utf8',
          timeout: 5_000,
          env: { ...process.env, [FIFO_CHILD_USER_DATA]: userDataPath }
        }
      )

      expect((child.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT')
      expect(child.status, child.stderr).toBe(0)
      expect(existsSync(lockPath(userDataPath))).toBe(false)
    }
  )

  it('loads an existing valid root without re-running the missing-root artifact scan', () => {
    const userDataPath = tempUserData()
    writePersistedRoot(userDataPath, randomBytes(32))
    writeJson(join(userDataPath, 'scheduled-tasks.json'), [
      { occurrenceSeal: { schemaVersion: 1 } }
    ])
    const authority = store(userDataPath).loadOrCreate()
    expect(authority.rootId).toMatch(/^twso-root-v1:/)
    authority.dispose()
  })

  it('releases its exact late lock and loads a winner committed after the first root check', async () => {
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const winner = randomBytes(32)
    writePersistedRoot(userDataPath, winner)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let hidInitialRoot = false

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      lstatSync: (path: string, options?: { bigint?: boolean }) => {
        if (path === rootTarget && !hidInitialRoot) {
          hidInitialRoot = true
          throw Object.assign(new Error('injected initial root miss'), { code: 'ENOENT' })
        }
        return options?.bigint
          ? actualFs.lstatSync(path, { bigint: true })
          : actualFs.lstatSync(path)
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      const authority = new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
        userDataPath,
        safeStorage: secureStorage
      }).loadOrCreate()
      expect(authority.rootId).toBe(rootIdFor(winner))
      authority.dispose()
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(hidInitialRoot).toBe(true)
    expect(existsSync(rootTarget)).toBe(true)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
    winner.fill(0)
  })

  it.skipIf(process.platform === 'win32')(
    'does not expose a visible root until the exact initialization lock is released',
    async () => {
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let injected = false
    let concurrentError = ''
    let DynamicStore: typeof ScheduledOccurrenceAuthorityRootStore

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      linkSync: (existingPath: string, newPath: string) => {
        actualFs.linkSync(existingPath, newPath)
        if (newPath !== rootTarget || injected) return
        injected = true
        try {
          new DynamicStore({
            userDataPath,
            safeStorage: secureStorage,
          }).loadOrCreate()
        } catch (error) {
          concurrentError = error instanceof Error ? error.message : String(error)
        }
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      DynamicStore = dynamicModule.ScheduledOccurrenceAuthorityRootStore
      const initializer = new DynamicStore({
        userDataPath,
        safeStorage: secureStorage,
      }).loadOrCreate()
      expect(initializer.rootId).toMatch(/^twso-root-v1:/)
      initializer.dispose()
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(injected).toBe(true)
    expect(concurrentError).toMatch(/root is not ready/)
    expect(existsSync(rootTarget)).toBe(true)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
    expect(readdirSync(userDataPath).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'returns no authority when root publication directory fsync fails',
    async () => {
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let rootLinked = false
    let injectedFailure = false

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      linkSync: (existingPath: string, newPath: string) => {
        actualFs.linkSync(existingPath, newPath)
        if (newPath === rootTarget) rootLinked = true
      },
      fsyncSync: (fd: number) => {
        if (rootLinked && !injectedFailure) {
          injectedFailure = true
          throw new Error('injected root directory fsync failure')
        }
        actualFs.fsyncSync(fd)
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      expect(() =>
        new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
          userDataPath,
          safeStorage: secureStorage,
        }).loadOrCreate()
      ).toThrow(/injected root directory fsync failure/)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(rootLinked).toBe(true)
    expect(injectedFailure).toBe(true)
    expect(existsSync(rootTarget)).toBe(false)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
    expect(readdirSync(userDataPath).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves the lock when root EEXIST cleanup fsync fails around a different winner',
    async () => {
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const winner = randomBytes(32)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let installedWinner = false
    let sawRootEexist = false
    let injectedFailure = false
    const injectingStorage: ScheduledOccurrenceAuthoritySafeStorage = {
      ...secureStorage,
      encryptString: (plaintext) => {
        if (!installedWinner) {
          installedWinner = true
          writePersistedRoot(userDataPath, winner)
        }
        return secureStorage.encryptString(plaintext)
      }
    }

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      linkSync: (existingPath: string, newPath: string) => {
        try {
          actualFs.linkSync(existingPath, newPath)
        } catch (error) {
          if (
            newPath === rootTarget &&
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error as NodeJS.ErrnoException).code === 'EEXIST'
          ) {
            sawRootEexist = true
          }
          throw error
        }
      },
      fsyncSync: (fd: number) => {
        if (sawRootEexist && !injectedFailure) {
          injectedFailure = true
          throw new Error('injected EEXIST cleanup directory fsync failure')
        }
        actualFs.fsyncSync(fd)
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      expect(() =>
        new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
          userDataPath,
          safeStorage: injectingStorage,
        }).loadOrCreate()
      ).toThrow(/injected EEXIST cleanup directory fsync failure/)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(installedWinner).toBe(true)
    expect(sawRootEexist).toBe(true)
    expect(injectedFailure).toBe(true)
    expect(JSON.parse(readFileSync(rootTarget, 'utf8'))).toMatchObject({ rootId: rootIdFor(winner) })
    expect(existsSync(lockPath(userDataPath))).toBe(true)
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is not ready/)
    winner.fill(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves a clean replacement root and lock when published identity changes',
    async () => {
      const userDataPath = tempUserData()
      const rootTarget = authorityPath(userDataPath)
      const winner = randomBytes(32)
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
      let swapped = false

      vi.resetModules()
      vi.doMock('node:fs', () => ({
        ...actualFs,
        linkSync: (existingPath: string, newPath: string) => {
          actualFs.linkSync(existingPath, newPath)
          if (newPath !== rootTarget || swapped) return
          swapped = true
          actualFs.unlinkSync(rootTarget)
          writePersistedRoot(userDataPath, winner)
        }
      }))

      try {
        const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
        expect(() =>
          new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
            userDataPath,
            safeStorage: secureStorage
          }).loadOrCreate()
        ).toThrow(/lost its exact file identity or content/)
      } finally {
        vi.doUnmock('node:fs')
        vi.resetModules()
      }

      expect(swapped).toBe(true)
      expect(JSON.parse(readFileSync(rootTarget, 'utf8'))).toMatchObject({
        rootId: rootIdFor(winner)
      })
      expect(existsSync(lockPath(userDataPath))).toBe(true)
      expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is not ready/)
      winner.fill(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves the lock and replacement when the candidate is swapped before final scan',
    async () => {
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const tasksTarget = join(userDataPath, 'scheduled-tasks.json')
    const winner = randomBytes(32)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let swapped = false

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      linkSync: (existingPath: string, newPath: string) => {
        actualFs.linkSync(existingPath, newPath)
        if (newPath !== rootTarget || swapped) return
        swapped = true
        actualFs.unlinkSync(rootTarget)
        writePersistedRoot(userDataPath, winner)
        actualFs.writeFileSync(
          tasksTarget,
          JSON.stringify([
            { id: 'replacement-race', occurrenceSeal: legacySeal({ schemaVersion: 2 }) }
          ])
        )
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      expect(() =>
        new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
          userDataPath,
          safeStorage: secureStorage,
        }).loadOrCreate()
      ).toThrow(/preserving the initialization lock/)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(swapped).toBe(true)
    expect(JSON.parse(readFileSync(rootTarget, 'utf8'))).toMatchObject({ rootId: rootIdFor(winner) })
    expect(existsSync(lockPath(userDataPath))).toBe(true)
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is not ready/)
    winner.fill(0)
    }
  )
})

describe('ScheduledOccurrenceAuthorityRootStore platform durability', () => {
  it('creates and reloads one stable authority through the Windows fsync protocol', () => {
    emulateProcessPlatform('win32')
    const userDataPath = tempUserData()
    const first = store(userDataPath).loadOrCreate()
    const second = store(userDataPath).loadOrCreate()
    const payload = Buffer.from('windows authority reload')

    expect(first.rootId).toBe(second.rootId)
    expect(first.sealPayloadMac(payload)).toBe(second.sealPayloadMac(payload))
    expect(existsSync(authorityPath(userDataPath))).toBe(true)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
    expect(readdirSync(userDataPath).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    first.dispose()
    second.dispose()
  })

  it('flushes the Windows root descriptor before close and successful return', async () => {
    emulateProcessPlatform('win32')
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let rootFd: number | null = null
    let rootFsynced = false
    let rootClosedAfterFsync = false

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      openSync: (path: string, flags: number, mode?: number) => {
        const fd = actualFs.openSync(path, flags, mode)
        if (path === rootTarget) rootFd = fd
        return fd
      },
      fsyncSync: (fd: number) => {
        if (fd === rootFd) rootFsynced = true
        actualFs.fsyncSync(fd)
      },
      closeSync: (fd: number) => {
        if (fd === rootFd && !rootClosedAfterFsync) {
          if (!rootFsynced) throw new Error('root descriptor closed before fsync')
          rootClosedAfterFsync = true
        }
        actualFs.closeSync(fd)
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      const authority = new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
        userDataPath,
        safeStorage: secureStorage
      }).loadOrCreate()
      expect(authority.rootId).toMatch(/^twso-root-v1:/)
      authority.dispose()
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(rootFsynced).toBe(true)
    expect(rootClosedAfterFsync).toBe(true)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
  })

  it('preserves a partial Windows root and lock when publication fails', async () => {
    emulateProcessPlatform('win32')
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let rootFd: number | null = null
    let injectedFailure = false

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      openSync: (path: string, flags: number, mode?: number) => {
        const fd = actualFs.openSync(path, flags, mode)
        if (path === rootTarget) {
          rootFd = fd
        }
        return fd
      },
      writeFileSync: (file: string | number, data: string, encoding: BufferEncoding) => {
        if (file === rootFd && !injectedFailure) {
          injectedFailure = true
          actualFs.writeFileSync(file, data.slice(0, 17), encoding)
          throw new Error('injected partial Windows authority-root write failure')
        }
        actualFs.writeFileSync(file, data, encoding)
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      expect(() =>
        new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
          userDataPath,
          safeStorage: secureStorage
        }).loadOrCreate()
      ).toThrow(/failed after its Windows root became visible/)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(injectedFailure).toBe(true)
    expect(readFileSync(rootTarget)).toHaveLength(17)
    expect(existsSync(lockPath(userDataPath))).toBe(true)
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is not ready/)
  })

  it('preserves the visible Windows root and lock when FlushFileBuffers fails', async () => {
    emulateProcessPlatform('win32')
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let rootFd: number | null = null
    let injectedFailure = false

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      openSync: (path: string, flags: number, mode?: number) => {
        const fd = actualFs.openSync(path, flags, mode)
        if (path === rootTarget) rootFd = fd
        return fd
      },
      fsyncSync: (fd: number) => {
        if (fd === rootFd && !injectedFailure) {
          injectedFailure = true
          throw new Error('injected Windows FlushFileBuffers failure')
        }
        actualFs.fsyncSync(fd)
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      expect(() =>
        new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
          userDataPath,
          safeStorage: secureStorage
        }).loadOrCreate()
      ).toThrow(/failed after its Windows root became visible/)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(injectedFailure).toBe(true)
    expect(JSON.parse(readFileSync(rootTarget, 'utf8'))).toMatchObject({ schemaVersion: 1 })
    expect(existsSync(lockPath(userDataPath))).toBe(true)
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is not ready/)
  })

  it('preserves the Windows root and lock when the final artifact scan fails', async () => {
    emulateProcessPlatform('win32')
    const userDataPath = tempUserData()
    const rootTarget = authorityPath(userDataPath)
    const tasksTarget = join(userDataPath, 'scheduled-tasks.json')
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let rootFd: number | null = null
    let injectedArtifact = false

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      openSync: (path: string, flags: number, mode?: number) => {
        const fd = actualFs.openSync(path, flags, mode)
        if (path === rootTarget) rootFd = fd
        return fd
      },
      closeSync: (fd: number) => {
        actualFs.closeSync(fd)
        if (fd === rootFd && !injectedArtifact) {
          injectedArtifact = true
          actualFs.writeFileSync(
            tasksTarget,
            JSON.stringify([{ id: 'late-v2', occurrenceSeal: { schemaVersion: 2 } }])
          )
        }
      }
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      expect(() =>
        new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
          userDataPath,
          safeStorage: secureStorage
        }).loadOrCreate()
      ).toThrow(/failed after its Windows root became visible/)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(injectedArtifact).toBe(true)
    expect(JSON.parse(readFileSync(rootTarget, 'utf8'))).toMatchObject({ schemaVersion: 1 })
    expect(existsSync(lockPath(userDataPath))).toBe(true)
    expect(() => store(userDataPath).loadOrCreate()).toThrow(/root is not ready/)
  })

  it('accepts stable bigint file identities above Number.MAX_SAFE_INTEGER', async () => {
    const userDataPath = tempUserData()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const hugeBase = BigInt(Number.MAX_SAFE_INTEGER) + 10_000n
    const withHugeIdentity = <T extends { dev: bigint; ino: bigint }>(stat: T): T =>
      new Proxy(stat, {
        get: (target, property) => {
          if (property === 'dev') return hugeBase + (target.dev & 0xfffffn)
          if (property === 'ino') return hugeBase + (target.ino & 0xfffffn)
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        }
      })

    vi.resetModules()
    vi.doMock('node:fs', () => ({
      ...actualFs,
      fstatSync: (fd: number) =>
        withHugeIdentity(actualFs.fstatSync(fd, { bigint: true })),
      lstatSync: (path: string, options?: { bigint?: boolean }) =>
        options?.bigint
          ? withHugeIdentity(actualFs.lstatSync(path, { bigint: true }))
          : actualFs.lstatSync(path)
    }))

    try {
      const dynamicModule = await import('./ScheduledOccurrenceAuthorityRootStore')
      const first = new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
        userDataPath,
        safeStorage: secureStorage
      }).loadOrCreate()
      const second = new dynamicModule.ScheduledOccurrenceAuthorityRootStore({
        userDataPath,
        safeStorage: secureStorage
      }).loadOrCreate()
      expect(first.rootId).toBe(second.rootId)
      first.dispose()
      second.dispose()
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    expect(existsSync(authorityPath(userDataPath))).toBe(true)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
  })

  it('fails closed on platforms without a reviewed publication protocol', () => {
    emulateProcessPlatform('freebsd')
    const userDataPath = tempUserData()
    expect(() => store(userDataPath).loadOrCreate()).toThrow(
      /no reviewed durable no-clobber publication protocol/
    )
    expect(existsSync(authorityPath(userDataPath))).toBe(false)
    expect(existsSync(lockPath(userDataPath))).toBe(false)
  })
})
