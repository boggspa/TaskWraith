import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, createVerify } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Http2ApnsPusher, derEcdsaToConcat } from './Http2ApnsPusher'
import { deriveAgreementPublicRaw, sealPush } from '../shared/e2ee/pushSeal'

/** Generate a fresh P-256 keypair in PKCS8 PEM (the .p8 format Apple
 * issues) for use in tests — written to a tmp file so the pusher can
 * read it like a real auth key. */
function writeTestAuthKey(): { dir: string; path: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  const dir = mkdtempSync(join(tmpdir(), 'apns-test-'))
  const path = join(dir, 'AuthKey_TESTKEYID00.p8')
  writeFileSync(path, privateKey, 'utf-8')
  return { dir, path, publicKeyPem: publicKey }
}

describe('Http2ApnsPusher — JWT generation', () => {
  it('rejects a non-PEM .p8 file at construction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apns-test-'))
    const path = join(dir, 'bogus.p8')
    writeFileSync(path, 'not a pem key', 'utf-8')
    try {
      expect(
        () =>
          new Http2ApnsPusher({
            authKeyPath: path,
            keyId: 'KEYID000',
            teamId: 'TEAM00000',
            bundleId: 'com.example.app'
          })
      ).toThrow(/PEM-encoded PKCS8/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Phase E1: Settings-UI path injects decrypted PEM in-memory rather
  // than a file path. Pin the constructor accepts it and validates the
  // PEM header same as the path branch.
  it('accepts authKeyPem in-memory and never touches disk', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const pusher = new Http2ApnsPusher({
      authKeyPem: privateKey,
      keyId: 'TESTKEYID0',
      teamId: 'TESTTEAM00',
      bundleId: 'com.example.app'
    })
    expect(pusher).toBeInstanceOf(Http2ApnsPusher)
  })

  it('rejects authKeyPem that does not look like a PKCS8 PEM', () => {
    expect(
      () =>
        new Http2ApnsPusher({
          authKeyPem: '-----BEGIN GARBAGE-----\nblob\n-----END GARBAGE-----\n',
          keyId: 'TESTKEYID0',
          teamId: 'TESTTEAM00',
          bundleId: 'com.example.app'
        })
    ).toThrow(/PEM-encoded PKCS8/)
  })

  it('throws when neither authKeyPem nor authKeyPath is provided', () => {
    expect(
      () =>
        new Http2ApnsPusher({
          keyId: 'TESTKEYID0',
          teamId: 'TESTTEAM00',
          bundleId: 'com.example.app'
        } as never)
    ).toThrow(/authKeyPem or authKeyPath/)
  })

  it('signs a verifiable JWT with the expected header + claims', () => {
    const { dir, path, publicKeyPem } = writeTestAuthKey()
    try {
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'TESTKEYID0',
        teamId: 'TESTTEAM00',
        bundleId: 'com.example.app',
        now: () => new Date(1_700_000_000_000)
      })
      // ensureJwt is private; we call it indirectly by reflecting on
      // the cached JWT after a delivery call (which will fail without
      // a real session — that's fine, JWT is built before the network
      // request). Test the public surface instead by examining the
      // first push attempt's expected behavior via the helper.
      //
      // Direct test: cast to access private signJwt via the cache that
      // ensureJwt populates. Use a custom connect that captures the
      // request headers.
      const headerCaptures: Array<Record<string, unknown>> = []
      const mockConnect = (_authority: string) => {
        return {
          closed: false,
          destroyed: false,
          on: () => {},
          request: (headers: Record<string, unknown>) => {
            headerCaptures.push(headers)
            return {
              on: (_event: string, _cb: unknown) => {},
              setEncoding: () => {},
              write: () => {},
              end: () => {}
            }
          },
          close: () => {}
        } as never
      }
      const pusherWithMock = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'TESTKEYID0',
        teamId: 'TESTTEAM00',
        bundleId: 'com.example.app',
        connect: mockConnect,
        now: () => new Date(1_700_000_000_000)
      })
      void pusherWithMock // satisfy lint
      void pusher
      // Trigger the request so headers get captured.
      void pusherWithMock.pushApprovalToToken('deadbeef', 'sandbox', {
        pairID: 'p',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc',
        summary: 'test'
      })
      // The push promise won't resolve (mock doesn't fire response event),
      // but the request has been built synchronously and headers captured.
      // Allow microtask to flush.
      return Promise.resolve().then(() => {
        expect(headerCaptures.length).toBe(1)
        const headers = headerCaptures[0]
        const auth = String(headers.authorization)
        expect(auth.startsWith('bearer ')).toBe(true)
        const jwt = auth.slice('bearer '.length)
        const parts = jwt.split('.')
        expect(parts.length).toBe(3)
        // Decode header
        const headerJson = JSON.parse(
          Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
        )
        expect(headerJson.alg).toBe('ES256')
        expect(headerJson.kid).toBe('TESTKEYID0')
        expect(headerJson.typ).toBe('JWT')
        // Decode claims
        const claimsJson = JSON.parse(
          Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
        )
        expect(claimsJson.iss).toBe('TESTTEAM00')
        expect(claimsJson.iat).toBe(1_700_000_000)

        // Verify the signature using the public key. APNs accepts r||s
        // concat; Node's verifier wants DER. To verify here, we
        // re-construct DER from the concat signature.
        const signature = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
        // signature is 64 bytes (r||s) for ES256.
        expect(signature.length).toBe(64)
        const r = signature.subarray(0, 32)
        const s = signature.subarray(32, 64)
        // Re-encode as DER for Node's verify
        const derSig = concatToDer(r, s)
        const verifier = createVerify('SHA256')
        verifier.update(`${parts[0]}.${parts[1]}`)
        verifier.end()
        const ok = verifier.verify(publicKeyPem, derSig)
        expect(ok).toBe(true)

        // Other headers Apple expects
        expect(headers['apns-topic']).toBe('com.example.app')
        expect(headers[':path']).toBe('/3/device/deadbeef')
        expect(headers[':method']).toBe('POST')
        expect(headers['apns-push-type']).toBe('alert')
        expect(headers['apns-priority']).toBe('10')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses a cached JWT across multiple pushes', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const headerCaptures: Array<Record<string, unknown>> = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: (headers: Record<string, unknown>) => {
            headerCaptures.push(headers)
            return {
              on: (_event: string, _cb: unknown) => {},
              setEncoding: () => {},
              write: () => {},
              end: () => {}
            }
          },
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYIDABCDE',
        teamId: 'TEAMIDABCD',
        bundleId: 'com.example.app',
        connect: mockConnect,
        now: () => new Date(1_700_000_000_000)
      })
      void pusher.pushApprovalToToken('a', 'sandbox', {
        pairID: 'p1',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc1',
        summary: 's'
      })
      void pusher.pushApprovalToToken('b', 'sandbox', {
        pairID: 'p1',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc2',
        summary: 's'
      })
      void pusher.pushApprovalToToken('c', 'sandbox', {
        pairID: 'p1',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc3',
        summary: 's'
      })
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          expect(headerCaptures.length).toBe(3)
          const jwt1 = String(headerCaptures[0].authorization)
          const jwt2 = String(headerCaptures[1].authorization)
          const jwt3 = String(headerCaptures[2].authorization)
          // All three should share the same JWT (same iat, same signature).
          expect(jwt1).toBe(jwt2)
          expect(jwt2).toBe(jwt3)
        })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('mints a new JWT after lifetime expires', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const headerCaptures: Array<Record<string, unknown>> = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: (headers: Record<string, unknown>) => {
            headerCaptures.push(headers)
            return {
              on: (_event: string, _cb: unknown) => {},
              setEncoding: () => {},
              write: () => {},
              end: () => {}
            }
          },
          close: () => {}
        }) as never
      let clock = 1_700_000_000_000
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect,
        jwtLifetimeSeconds: 60, // very short for the test
        now: () => new Date(clock)
      })
      void pusher.pushApprovalToToken('a', 'sandbox', {
        pairID: 'p',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc1',
        summary: 's'
      })
      return Promise.resolve().then(() => {
        // Advance clock past the JWT's lifetime
        clock += 2 * 60 * 1000 // 2 minutes
        void pusher.pushApprovalToToken('b', 'sandbox', {
          pairID: 'p',
          workspaceId: 'w',
          threadId: 't',
          toolCallId: 'tc2',
          summary: 's'
        })
        return Promise.resolve().then(() => {
          expect(headerCaptures.length).toBe(2)
          const jwt1 = String(headerCaptures[0].authorization)
          const jwt2 = String(headerCaptures[1].authorization)
          expect(jwt1).not.toBe(jwt2) // different iat → different signature
        })
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Http2ApnsPusher — endpoint selection', () => {
  it('connects to sandbox host for sandbox env', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const authorities: string[] = []
      const mockConnect = (authority: string) => {
        authorities.push(authority)
        return {
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: () => {},
            end: () => {}
          }),
          close: () => {}
        } as never
      }
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushApprovalToToken('a', 'sandbox', {
        pairID: 'p',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc',
        summary: 's'
      })
      return Promise.resolve().then(() => {
        expect(authorities).toContain('https://api.sandbox.push.apple.com')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('connects to production host for production env', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const authorities: string[] = []
      const mockConnect = (authority: string) => {
        authorities.push(authority)
        return {
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: () => {},
            end: () => {}
          }),
          close: () => {}
        } as never
      }
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushApprovalToToken('a', 'production', {
        pairID: 'p',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc',
        summary: 's'
      })
      return Promise.resolve().then(() => {
        expect(authorities).toContain('https://api.push.apple.com')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forceEnv overrides per-call env', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const authorities: string[] = []
      const mockConnect = (authority: string) => {
        authorities.push(authority)
        return {
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: () => {},
            end: () => {}
          }),
          close: () => {}
        } as never
      }
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        forceEnv: 'sandbox',
        connect: mockConnect
      })
      // Caller says 'production' but forceEnv pins to sandbox.
      void pusher.pushApprovalToToken('a', 'production', {
        pairID: 'p',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc',
        summary: 's'
      })
      return Promise.resolve().then(() => {
        expect(authorities).toContain('https://api.sandbox.push.apple.com')
        expect(authorities).not.toContain('https://api.push.apple.com')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Http2ApnsPusher — privacy-safe alert bodies', () => {
  const forbiddenPushContent = [
    'PRIVATE_PROMPT_TEXT',
    'PRIVATE_APPROVAL_BODY',
    'PRIVATE_COMMAND_TEXT',
    'PRIVATE_DIFF_HUNK',
    '/Users/dev/private-project'
  ]

  function expectNoForbiddenPushContent(serialized: string): void {
    for (const forbidden of forbiddenPushContent) {
      expect(serialized).not.toContain(forbidden)
    }
  }

  it('omits summaries, commands, file paths, and deep links from approval alerts', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushApprovalToToken('a', 'sandbox', {
        pairID: 'p',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc',
        summary: 'PRIVATE_APPROVAL_BODY: approve PRIVATE_COMMAND_TEXT?',
        deepLinkPath: '/Users/dev/private-project/file.ts',
        promptText: 'PRIVATE_PROMPT_TEXT',
        approvalBody: 'PRIVATE_APPROVAL_BODY',
        commandText: 'PRIVATE_COMMAND_TEXT',
        filePaths: ['/Users/dev/private-project/file.ts'],
        diffHunks: ['@@ PRIVATE_DIFF_HUNK @@']
      } as never)
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        const serialized = JSON.stringify(body)
        expect(body.aps.alert).toEqual({
          title: 'TaskWraith needs attention',
          body: 'Open TaskWraith to respond.'
        })
        expect(body.aps['thread-id']).toBe('t')
        expect(body.aps['relevance-score']).toBe(0.95)
        expect(body).toMatchObject({
          pairID: 'p',
          workspaceId: 'w',
          threadId: 't',
          toolCallId: 'tc'
        })
        expect(body.deepLinkPath).toBeUndefined()
        expect(body.expiresAt).toBeUndefined()
        expectNoForbiddenPushContent(serialized)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips path-like workspace ids from approval alerts', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushApprovalToToken('a', 'sandbox', {
        pairID: 'p',
        workspaceId: '/Users/dev/private-project',
        threadId: 't',
        toolCallId: 'tc',
        summary: 'PRIVATE_APPROVAL_BODY'
      })
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        const serialized = JSON.stringify(body)
        expect(body.workspaceId).toBeUndefined()
        expectNoForbiddenPushContent(serialized)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends remote attention alerts with routing identifiers only', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushRemoteAttentionToToken('a', 'sandbox', {
        pairID: 'p',
        reason: 'ensemble',
        workspaceId: 'w',
        threadId: 't',
        runId: 'r',
        wakeupId: 'wake',
        taskId: 'task',
        projectionKind: 'RemoteEnsembleState',
        generatedAt: '2026-05-30T12:00:00.000Z',
        deepLinkPath: '/Users/dev/private-project/file.ts',
        summary: 'PRIVATE_APPROVAL_BODY',
        promptText: 'PRIVATE_PROMPT_TEXT',
        approvalBody: 'PRIVATE_APPROVAL_BODY',
        commandText: 'PRIVATE_COMMAND_TEXT',
        filePaths: ['/Users/dev/private-project/file.ts'],
        diffHunks: ['@@ PRIVATE_DIFF_HUNK @@']
      } as never)
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        const serialized = JSON.stringify(body)
        expect(body.aps.alert).toEqual({
          title: 'TaskWraith needs attention',
          body: 'Open TaskWraith to review the latest task state.'
        })
        expect(body.aps['thread-id']).toBe('t')
        expect(body.aps['relevance-score']).toBe(0.5)
        expect(body).toMatchObject({
          pairID: 'p',
          reason: 'ensemble',
          workspaceId: 'w',
          threadId: 't',
          runId: 'r',
          wakeupId: 'wake',
          taskId: 'task',
          projectionKind: 'RemoteEnsembleState'
        })
        expect(body.deepLinkPath).toBeUndefined()
        expect(body.summary).toBeUndefined()
        expectNoForbiddenPushContent(serialized)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serializes the encrypted twpush blob OUTSIDE aps + keeps the generic alert', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      const envelope = sealPush({
        senderIdentitySeed: Buffer.alloc(32, 0x11),
        recipientAgreePubRaw: deriveAgreementPublicRaw(Buffer.alloc(32, 0x22)),
        pairId: 'p',
        plaintext: Buffer.from('{"title":"Codex","preview":"done"}', 'utf8')
      })
      void pusher.pushRemoteAttentionToToken('a', 'production', {
        pairID: 'p',
        reason: 'runComplete',
        threadId: 't',
        runId: 'r',
        taskId: 'task',
        twpush: envelope
      })
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        // Blob rides OUTSIDE aps (only the NSE reads it) and is verbatim.
        expect(body.twpush).toEqual(envelope)
        expect(body.aps.twpush).toBeUndefined()
        // The generic alert is untouched — it's the NSE's fallback.
        expect(body.aps.alert).toEqual({
          title: 'Task complete',
          body: 'Your TaskWraith run finished.'
        })
        expect(body.aps['mutable-content']).toBe(1)
        // Ciphertext only — none of the plaintext leaks.
        expect(JSON.stringify(body)).not.toContain('Codex')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops an oversized twpush blob and ships the generic alert (4KB guard)', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushRemoteAttentionToToken('a', 'production', {
        pairID: 'p',
        reason: 'runComplete',
        threadId: 't',
        twpush: { v: 1, s: 'AAAA', n: 'AAAA', ct: 'A'.repeat(4200), tag: 'AAAA' }
      })
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        expect(body.twpush).toBeUndefined() // dropped — too big
        expect(Buffer.byteLength(bodyWrites[0], 'utf8')).toBeLessThanOrEqual(4096)
        expect(body.aps.alert).toEqual({
          title: 'Task complete',
          body: 'Your TaskWraith run finished.'
        })
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips path-like workspace ids from remote attention alerts', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushRemoteAttentionToToken('a', 'sandbox', {
        pairID: 'p',
        reason: 'approval',
        workspaceId: '/Users/dev/private-project',
        threadId: 't',
        approvalId: 'a-1'
      })
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        const serialized = JSON.stringify(body)
        expect(body.workspaceId).toBeUndefined()
        expectNoForbiddenPushContent(serialized)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sets aps.category for blocking reasons only (lock-screen action buttons)', async () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushRemoteAttentionToToken('a', 'sandbox', {
        pairID: 'p',
        reason: 'approval',
        threadId: 't',
        approvalId: 'a-1'
      })
      void pusher.pushRemoteAttentionToToken('a', 'sandbox', {
        pairID: 'p',
        reason: 'question',
        threadId: 't',
        questionId: 'q-1'
      })
      void pusher.pushRemoteAttentionToToken('a', 'sandbox', {
        pairID: 'p',
        reason: 'runComplete',
        threadId: 't'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(JSON.parse(bodyWrites[0]).aps.category).toBe('TW_APPROVAL')
      expect(JSON.parse(bodyWrites[0]).aps['thread-id']).toBe('t')
      expect(JSON.parse(bodyWrites[0]).aps['relevance-score']).toBe(1)
      expect(JSON.parse(bodyWrites[1]).aps.category).toBe('TW_QUESTION')
      expect(JSON.parse(bodyWrites[1]).aps['thread-id']).toBe('t')
      expect(JSON.parse(bodyWrites[1]).aps['relevance-score']).toBe(1)
      // Non-blocking reason → no category → no lock-screen buttons.
      expect(JSON.parse(bodyWrites[2]).aps.category).toBeUndefined()
      expect(JSON.parse(bodyWrites[2]).aps['thread-id']).toBe('t')
      expect(JSON.parse(bodyWrites[2]).aps['relevance-score']).toBe(0.35)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends silent wake/resume pushes with routing identifiers only', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushSilentToToken('a', 'sandbox', {
        reason: 'resume',
        workspaceId: 'w',
        threadId: 't',
        runId: 'r',
        approvalId: 'approval',
        questionId: 'question',
        wakeupId: 'wake',
        taskId: 'task',
        projectionKind: 'RemoteThreadSnapshot',
        generatedAt: '2026-05-30T12:00:00.000Z',
        promptText: 'PRIVATE_PROMPT_TEXT',
        approvalBody: 'PRIVATE_APPROVAL_BODY',
        commandText: 'PRIVATE_COMMAND_TEXT',
        filePath: '/Users/dev/private-project/file.ts',
        diffHunks: ['@@ PRIVATE_DIFF_HUNK @@']
      } as never)
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        const serialized = JSON.stringify(body)
        expect(body.aps).toEqual({ 'content-available': 1 })
        expect(body).toMatchObject({
          reason: 'resume',
          workspaceId: 'w',
          threadId: 't',
          runId: 'r',
          approvalId: 'approval',
          questionId: 'question',
          wakeupId: 'wake',
          taskId: 'task',
          projectionKind: 'RemoteThreadSnapshot'
        })
        expect(body.promptText).toBeUndefined()
        expect(body.approvalBody).toBeUndefined()
        expect(body.commandText).toBeUndefined()
        expect(body.filePath).toBeUndefined()
        expect(body.diffHunks).toBeUndefined()
        expectNoForbiddenPushContent(serialized)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips path-like workspace ids from silent wake pushes', () => {
    const { dir, path } = writeTestAuthKey()
    try {
      const bodyWrites: string[] = []
      const mockConnect = (_authority: string) =>
        ({
          closed: false,
          destroyed: false,
          on: () => {},
          request: () => ({
            on: () => {},
            setEncoding: () => {},
            write: (body: string) => {
              bodyWrites.push(body)
            },
            end: () => {}
          }),
          close: () => {}
        }) as never
      const pusher = new Http2ApnsPusher({
        authKeyPath: path,
        keyId: 'KEYID00000',
        teamId: 'TEAM00ABCD',
        bundleId: 'com.example.app',
        connect: mockConnect
      })
      void pusher.pushSilentToToken('a', 'sandbox', {
        reason: 'resume',
        workspaceId: '/Users/dev/private-project',
        threadId: 't'
      })
      return Promise.resolve().then(() => {
        const body = JSON.parse(bodyWrites[0])
        const serialized = JSON.stringify(body)
        expect(body.workspaceId).toBeUndefined()
        expectNoForbiddenPushContent(serialized)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('derEcdsaToConcat', () => {
  it('strips leading 0x00 padding from r and s INTEGERs', () => {
    // DER for r=0x01, s=0x02 (both 1-byte values)
    const der = Buffer.from([
      0x30,
      0x06, // SEQUENCE length 6
      0x02,
      0x01,
      0x01, // INTEGER 1 byte = 0x01
      0x02,
      0x01,
      0x02 // INTEGER 1 byte = 0x02
    ])
    const concat = derEcdsaToConcat(der, 32)
    expect(concat.length).toBe(64)
    // r should be left-padded; bytes 0-30 zero, byte 31 = 0x01
    expect(concat[30]).toBe(0x00)
    expect(concat[31]).toBe(0x01)
    expect(concat[62]).toBe(0x00)
    expect(concat[63]).toBe(0x02)
  })

  it('round-trips a real ES256 signature shape', () => {
    // 64-byte raw signature (random data) → concat → re-encode → parse
    // For this test we just verify the length + structural integrity.
    // Use a known ES256 sig length: typical DER is 70-72 bytes.
    const r = Buffer.alloc(32, 0xab)
    const s = Buffer.alloc(32, 0xcd)
    const derSig = concatToDer(r, s)
    const back = derEcdsaToConcat(derSig, 32)
    expect(back.length).toBe(64)
    expect(back.subarray(0, 32)).toEqual(r)
    expect(back.subarray(32, 64)).toEqual(s)
  })
})

/** Test helper: concat (r||s) → DER ECDSA signature. Mirrors what an
 * ASN.1 encoder would produce. Used to round-trip test
 * `derEcdsaToConcat` and to verify our raw signature is what Node's
 * verifier expects. */
function concatToDer(r: Buffer, s: Buffer): Buffer {
  // Strip leading zero bytes EXCEPT keep one if the next byte has the
  // high bit set (otherwise the INTEGER would parse as negative).
  const trimR = trimLeading(r)
  const trimS = trimLeading(s)
  const rPadded = trimR[0] >= 0x80 ? Buffer.concat([Buffer.from([0x00]), trimR]) : trimR
  const sPadded = trimS[0] >= 0x80 ? Buffer.concat([Buffer.from([0x00]), trimS]) : trimS
  const total = 2 + rPadded.length + 2 + sPadded.length
  return Buffer.concat([
    Buffer.from([0x30, total]),
    Buffer.from([0x02, rPadded.length]),
    rPadded,
    Buffer.from([0x02, sPadded.length]),
    sPadded
  ])
}

function trimLeading(buf: Buffer): Buffer {
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0x00) i++
  return buf.subarray(i)
}
