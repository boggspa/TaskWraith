import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NoopApnsPusher,
  createBridgeApnsPusher,
  type BridgeApprovalPushPayload
} from './BridgeApnsPusher'

describe('NoopApnsPusher', () => {
  const samplePayload: BridgeApprovalPushPayload = {
    pairID: 'pair-1',
    workspaceId: 'ws-1',
    threadId: 't-1',
    toolCallId: 'tool-99',
    summary: 'Run `rm -rf /tmp/foo`?'
  }

  it('returns delivered=false with reason=noop for approval pushes', async () => {
    const pusher = new NoopApnsPusher()
    const result = await pusher.pushApprovalNeeded(samplePayload)
    expect(result.delivered).toBe(false)
    expect(result.apnsId).toBe('')
    expect(result.reason).toBe('noop')
  })

  it('returns delivered=false with reason=noop for silent pushes', async () => {
    const pusher = new NoopApnsPusher()
    const result = await pusher.pushSilent('pair-1')
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('noop')
  })

  it('returns delivered=false with reason=noop for remote attention pushes', async () => {
    const pusher = new NoopApnsPusher()
    const result = await pusher.pushRemoteAttentionNeeded({
      pairID: 'pair-1',
      reason: 'approval',
      workspaceId: 'ws-1',
      threadId: 't-1',
      approvalId: 'approval-1'
    })
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('noop')
  })

  it('logs intent when an approval push is requested', async () => {
    const log = vi.fn()
    const pusher = new NoopApnsPusher(log)
    await pusher.pushApprovalNeeded(samplePayload)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('approval')
    expect(log.mock.calls[0][0]).toContain('pair-1')
    expect(log.mock.calls[0][0]).toContain('ws-1')
    expect(log.mock.calls[0][0]).toContain('tool-99')
  })

  it('does not throw on any payload shape', async () => {
    const pusher = new NoopApnsPusher()
    await expect(
      pusher.pushApprovalNeeded({
        pairID: '',
        workspaceId: '',
        threadId: '',
        toolCallId: '',
        summary: ''
      })
    ).resolves.toMatchObject({ delivered: false })
  })
})

describe('createBridgeApnsPusher factory', () => {
  const envBackup = {
    apns: process.env.TASKWRAITH_BRIDGE_APNS,
    dry: process.env.TASKWRAITH_BRIDGE_APNS_DRY_RUN
  }

  afterEach(() => {
    if (envBackup.apns === undefined) delete process.env.TASKWRAITH_BRIDGE_APNS
    else process.env.TASKWRAITH_BRIDGE_APNS = envBackup.apns
    if (envBackup.dry === undefined) delete process.env.TASKWRAITH_BRIDGE_APNS_DRY_RUN
    else process.env.TASKWRAITH_BRIDGE_APNS_DRY_RUN = envBackup.dry
  })

  it('returns a NoopApnsPusher by default', async () => {
    delete process.env.TASKWRAITH_BRIDGE_APNS
    const pusher = createBridgeApnsPusher()
    expect(pusher).toBeInstanceOf(NoopApnsPusher)
  })

  it('logs the chosen env at construction', () => {
    const log = vi.fn()
    process.env.TASKWRAITH_BRIDGE_APNS = 'sandbox'
    createBridgeApnsPusher({ log })
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('env=sandbox')
  })

  it('respects explicit options over env vars', () => {
    const log = vi.fn()
    process.env.TASKWRAITH_BRIDGE_APNS = 'sandbox'
    createBridgeApnsPusher({ log, env: 'production' })
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('env=production')
  })

  it('returns NoopApnsPusher when no credentials are configured', () => {
    delete process.env.TASKWRAITH_APNS_KEY_PATH
    delete process.env.TASKWRAITH_APNS_KEY_ID
    delete process.env.TASKWRAITH_APNS_TEAM_ID
    delete process.env.TASKWRAITH_APNS_BUNDLE_ID
    const log = vi.fn()
    const pusher = createBridgeApnsPusher({ log })
    expect(pusher).toBeInstanceOf(NoopApnsPusher)
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('credentials missing')
  })

  it('honors dryRun: returns NoopApnsPusher even with credentials present', () => {
    // dryRun forces noop so a stray production deploy can't accidentally
    // deliver during staging tests.
    const log = vi.fn()
    const pusher = createBridgeApnsPusher({
      log,
      dryRun: true,
      credentials: {
        authKeyPath: '/nonexistent.p8',
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app'
      }
    })
    expect(pusher).toBeInstanceOf(NoopApnsPusher)
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('dryRun=true')
  })

  it('returns Http2ApnsPusher when full credentials are provided', async () => {
    // Use a valid generated .p8 so construction doesn't throw.
    const { generateKeyPairSync } = await import('crypto')
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const dir = mkdtempSync(join(tmpdir(), 'apns-factory-test-'))
    const path = join(dir, 'AuthKey_K.p8')
    writeFileSync(path, privateKey, 'utf-8')
    try {
      const pusher = createBridgeApnsPusher({
        credentials: {
          authKeyPath: path,
          keyId: 'KEYID00000',
          teamId: 'TEAM00ABCD',
          bundleId: 'com.example.app'
        }
      })
      expect(pusher).not.toBeInstanceOf(NoopApnsPusher)
      // The real pusher exposes pushApprovalToToken / pushSilentToToken
      // beyond the base interface. Verify duck-typed.
      expect(typeof (pusher as { pushApprovalToToken?: unknown }).pushApprovalToToken).toBe(
        'function'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression (D3): TASKWRAITH_BRIDGE_APNS was read into a local that only fed
  // the log line, so the documented override was inert. The fix must NOT default
  // forceEnv to 'production' when the var is unset — that would override the
  // per-device env captured at registration and strand every sandbox device.
  describe('APNs environment forcing', () => {
    async function makeCredentialedPusher(log: (line: string) => void) {
      const { generateKeyPairSync } = await import('crypto')
      const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
      const { join } = await import('path')
      const { tmpdir } = await import('os')
      const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
      })
      const dir = mkdtempSync(join(tmpdir(), 'apns-forceenv-test-'))
      const path = join(dir, 'AuthKey_K.p8')
      writeFileSync(path, privateKey, 'utf-8')
      try {
        createBridgeApnsPusher({
          log,
          credentials: {
            authKeyPath: path,
            keyId: 'KEYID00000',
            teamId: 'TEAM00ABCD',
            bundleId: 'com.example.app'
          }
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it('does NOT force an env when TASKWRAITH_BRIDGE_APNS is unset', async () => {
      delete process.env.TASKWRAITH_BRIDGE_APNS
      const log = vi.fn()
      await makeCredentialedPusher(log)
      const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
      expect(allLogs).toContain('env=per-device')
      expect(allLogs).not.toContain('FORCED')
    })

    it('does NOT force an env when TASKWRAITH_BRIDGE_APNS is an unrecognised value', async () => {
      process.env.TASKWRAITH_BRIDGE_APNS = 'yes-please'
      const log = vi.fn()
      await makeCredentialedPusher(log)
      const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
      expect(allLogs).toContain('env=per-device')
    })

    it.each(['sandbox', 'production'] as const)(
      'forces %s when TASKWRAITH_BRIDGE_APNS says so',
      async (value) => {
        process.env.TASKWRAITH_BRIDGE_APNS = value
        const log = vi.fn()
        await makeCredentialedPusher(log)
        const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
        expect(allLogs).toContain(`env=FORCED:${value}`)
      }
    )
  })

  it('falls back to NoopApnsPusher when credentials point at non-existent file', () => {
    const log = vi.fn()
    const pusher = createBridgeApnsPusher({
      log,
      credentials: {
        authKeyPath: '/tmp/definitely-does-not-exist-' + Date.now() + '.p8',
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app'
      }
    })
    expect(pusher).toBeInstanceOf(NoopApnsPusher)
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('falling back to NoopApnsPusher')
  })

  it('resolves credentials from env vars when no explicit options', async () => {
    const { generateKeyPairSync } = await import('crypto')
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const dir = mkdtempSync(join(tmpdir(), 'apns-envvar-test-'))
    const path = join(dir, 'AuthKey_K.p8')
    writeFileSync(path, privateKey, 'utf-8')
    process.env.TASKWRAITH_APNS_KEY_PATH = path
    process.env.TASKWRAITH_APNS_KEY_ID = 'KEYIDABC00'
    process.env.TASKWRAITH_APNS_TEAM_ID = 'TEAMABCD00'
    process.env.TASKWRAITH_APNS_BUNDLE_ID = 'com.example.fromenv'
    try {
      const pusher = createBridgeApnsPusher()
      expect(pusher).not.toBeInstanceOf(NoopApnsPusher)
    } finally {
      delete process.env.TASKWRAITH_APNS_KEY_PATH
      delete process.env.TASKWRAITH_APNS_KEY_ID
      delete process.env.TASKWRAITH_APNS_TEAM_ID
      delete process.env.TASKWRAITH_APNS_BUNDLE_ID
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports dryRun=true when env flag is set', () => {
    const log = vi.fn()
    process.env.TASKWRAITH_BRIDGE_APNS_DRY_RUN = '1'
    createBridgeApnsPusher({ log })
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('dryRun=true')
  })

  it('returned pusher honors the interface contract', async () => {
    const pusher = createBridgeApnsPusher()
    const approvalResult = await pusher.pushApprovalNeeded({
      pairID: 'p',
      workspaceId: 'w',
      threadId: 't',
      toolCallId: 'tc',
      summary: 's'
    })
    expect(approvalResult.delivered).toBe(false)
    const silentResult = await pusher.pushSilent('p')
    expect(silentResult.delivered).toBe(false)
    const attentionResult = await pusher.pushRemoteAttentionNeeded({
      pairID: 'p',
      reason: 'approval',
      workspaceId: 'w',
      threadId: 't',
      approvalId: 'a'
    })
    expect(attentionResult.delivered).toBe(false)
  })

  // Phase E1: Settings-UI path injects an already-decrypted PEM string
  // (from safeStorage) instead of a file path. The factory should accept
  // the in-memory credential without touching disk.
  it('returns Http2ApnsPusher when authKeyPem is provided in-memory', async () => {
    const { generateKeyPairSync } = await import('crypto')
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const log = vi.fn()
    const pusher = createBridgeApnsPusher({
      log,
      credentials: {
        authKeyPem: privateKey,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app'
      }
    })
    expect(pusher).not.toBeInstanceOf(NoopApnsPusher)
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('source=pem')
  })

  it('rejects credentials when neither authKeyPath nor authKeyPem is set', () => {
    const log = vi.fn()
    const pusher = createBridgeApnsPusher({
      log,
      credentials: {
        // Intentionally missing authKeyPath / authKeyPem.
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app'
      } as never
    })
    // Without a usable key, fall back to NoopApnsPusher with the
    // standard "credentials missing" log so the user sees why the
    // pusher is inert.
    expect(pusher).toBeInstanceOf(NoopApnsPusher)
    const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(allLogs).toContain('credentials missing')
  })

  it('prefers explicit pem credentials over env-var path', async () => {
    // If a user has both env vars (legacy) and Settings-UI credentials
    // (new flow), the explicit `options.credentials` wins.
    const { generateKeyPairSync } = await import('crypto')
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const { privateKey: envKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const { privateKey: optionKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const dir = mkdtempSync(join(tmpdir(), 'apns-precedence-test-'))
    const envPath = join(dir, 'AuthKey_Env.p8')
    writeFileSync(envPath, envKey, 'utf-8')
    process.env.TASKWRAITH_APNS_KEY_PATH = envPath
    process.env.TASKWRAITH_APNS_KEY_ID = 'ENVKEY0000'
    process.env.TASKWRAITH_APNS_TEAM_ID = 'ENVTEAM000'
    process.env.TASKWRAITH_APNS_BUNDLE_ID = 'com.env.test'
    try {
      const log = vi.fn()
      const pusher = createBridgeApnsPusher({
        log,
        credentials: {
          authKeyPem: optionKey,
          keyId: 'OPTKEY0000',
          teamId: 'OPTTEAM000',
          bundleId: 'com.opt.test'
        }
      })
      expect(pusher).not.toBeInstanceOf(NoopApnsPusher)
      const allLogs = log.mock.calls.map((c) => c[0] as string).join('\n')
      // The pusher should log the option-provided keyId, not the env one.
      expect(allLogs).toContain('keyId=OPTKEY0000')
      expect(allLogs).not.toContain('keyId=ENVKEY0000')
    } finally {
      delete process.env.TASKWRAITH_APNS_KEY_PATH
      delete process.env.TASKWRAITH_APNS_KEY_ID
      delete process.env.TASKWRAITH_APNS_TEAM_ID
      delete process.env.TASKWRAITH_APNS_BUNDLE_ID
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
