import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES,
  READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES,
  REMOTE_WORKSPACE_CAPABILITY_DESCRIPTIONS,
  GLOBAL_REMOTE_SCOPE,
  RemoteWorkspaceAllowlist,
  capabilitiesForRemoteWorkspaceEntry,
  capabilitiesForRemoteWorkspaceMode,
  describeRemoteWorkspaceCapability,
  isAdminRemoteWorkspaceCapability
} from './RemoteWorkspaceAllowlist'

describe('RemoteWorkspaceAllowlist', () => {
  describe('CRUD', () => {
    it('starts empty', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      expect(allowlist.size()).toBe(0)
      expect(allowlist.list()).toEqual([])
      expect(allowlist.get('anything')).toBeNull()
    })

    it('upserts a new entry with timestamps', () => {
      const allowlist = new RemoteWorkspaceAllowlist({ now: () => 1000 })
      const entry = allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/Users/foo/projects/a',
        mode: 'read-write'
      })
      expect(entry.workspaceId).toBe('ws-1')
      expect(entry.createdAt).toBe(1000)
      expect(entry.updatedAt).toBe(1000)
      expect(allowlist.size()).toBe(1)
    })

    it('updates an existing entry while preserving createdAt', () => {
      let clock = 1000
      const allowlist = new RemoteWorkspaceAllowlist({ now: () => clock })
      allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-only'
      })
      clock = 2000
      const updated = allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      expect(updated.createdAt).toBe(1000)
      expect(updated.updatedAt).toBe(2000)
      expect(updated.mode).toBe('read-write')
      expect(updated.capabilities).toEqual(READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES)
    })

    it('removes an entry and reports whether it existed', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      expect(allowlist.remove('ws-1')).toBe(true)
      expect(allowlist.remove('ws-1')).toBe(false)
      expect(allowlist.size()).toBe(0)
    })

    it('clears all entries', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      allowlist.upsert({
        workspaceId: 'ws-2',
        path: '/b',
        mode: 'read-only'
      })
      allowlist.clear()
      expect(allowlist.size()).toBe(0)
    })
  })

  describe('evaluate', () => {
    const seed = (clock = 1000) => {
      const allowlist = new RemoteWorkspaceAllowlist({ now: () => clock })
      allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      return allowlist
    }

    it('denies an unlisted workspace', () => {
      const allowlist = seed()
      const decision = allowlist.evaluate({ workspaceId: 'ws-missing' })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.reason).toMatch(/not on the remote allowlist/i)
      }
    })

    it('allows a listed workspace with no extra checks', () => {
      const allowlist = seed()
      const decision = allowlist.evaluate({ workspaceId: 'ws-1' })
      expect(decision.allowed).toBe(true)
    })

    it('applies one workspace grant to every provider identity', () => {
      const allowlist = seed()
      for (const provider of ['claude', 'codex', 'pi', 'antigravity', 'future-provider']) {
        expect(allowlist.evaluate({ workspaceId: 'ws-1', provider }).allowed).toBe(true)
      }
    })

    it('keeps every thread approval posture independent from the workspace grant', () => {
      const allowlist = seed()
      for (const approvalMode of ['plan', 'read-only', 'default', 'auto-edit', 'allow-all']) {
        expect(allowlist.evaluate({ workspaceId: 'ws-1', approvalMode }).allowed).toBe(true)
      }
    })

    it('does not require a thread approval posture on workspace checks', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-plan-only',
        path: '/a',
        mode: 'read-only'
      })

      const decision = allowlist.evaluate({
        workspaceId: 'ws-plan-only',
        provider: 'gemini'
      })

      expect(decision.allowed).toBe(true)
    })

    it('maps legacy read-only mode to monitor + approve capabilities', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-readonly',
        path: '/a',
        mode: 'read-only'
      })
      expect(capabilitiesForRemoteWorkspaceMode('read-only')).toEqual(
        READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES
      )
      expect(
        allowlist.evaluate({ workspaceId: 'ws-readonly', capability: 'approve' }).allowed
      ).toBe(true)
      const decision = allowlist.evaluate({ workspaceId: 'ws-readonly', capability: 'startTurn' })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.reason).toMatch(/capability "startTurn"/i)
      }
      expect(
        allowlist.evaluate({ workspaceId: 'ws-readonly', capability: 'fileBrowse' }).allowed
      ).toBe(false)
    })

    it('legacy read-write entries do NOT inherit the file-editing trio', () => {
      // A TRUE legacy entry: persisted before capabilities were
      // materialized at write time (no explicit list on disk). upsert()
      // can't produce this anymore — go through the load path.
      const dir = mkdtempSync(join(tmpdir(), 'tw-allowlist-'))
      const storagePath = join(dir, 'remote-workspaces.json')
      writeFileSync(
        storagePath,
        JSON.stringify({
          version: 1,
          entries: [
            {
              workspaceId: 'ws-1',
              path: '/a',
              mode: 'read-write',
              allowedProviders: ['gemini', 'codex'],
              allowedApprovalModes: ['default', 'plan'],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      )
      const allowlist = new RemoteWorkspaceAllowlist({ storagePath, now: () => 1000 })
      // Explicit read-write MODE still maps to the full default set (new
      // grants are written with explicit capabilities)...
      expect(capabilitiesForRemoteWorkspaceMode('read-write')).toEqual(
        READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES
      )
      expect(allowlist.evaluate({ workspaceId: 'ws-1', capability: 'startTurn' }).allowed).toBe(
        true
      )
      // ...but entries persisted WITHOUT explicit capabilities predate
      // remote file editing — a new power must not silently attach to old
      // grants (security review, no-ship finding).
      expect(allowlist.evaluate({ workspaceId: 'ws-1', capability: 'fileBrowse' }).allowed).toBe(
        false
      )
      expect(allowlist.evaluate({ workspaceId: 'ws-1', capability: 'fileRead' }).allowed).toBe(
        false
      )
      expect(allowlist.evaluate({ workspaceId: 'ws-1', capability: 'fileWrite' }).allowed).toBe(
        false
      )
      expect(
        allowlist.evaluate({ workspaceId: 'ws-1', capability: 'externalPublish' }).allowed
      ).toBe(false)
      expect(allowlist.evaluate({ workspaceId: 'ws-1', capability: 'yolo' }).allowed).toBe(false)
      const migrated = JSON.parse(readFileSync(storagePath, 'utf-8'))
      expect(migrated.version).toBe(2)
      expect(migrated.entries[0]).not.toHaveProperty('allowedProviders')
      expect(migrated.entries[0]).not.toHaveProperty('allowedApprovalModes')
      rmSync(dir, { recursive: true, force: true })
    })

    it('keeps external publishing, pin, and yolo as explicit admin-only capabilities outside defaults', () => {
      expect(capabilitiesForRemoteWorkspaceMode('read-write')).not.toContain('externalPublish')
      expect(capabilitiesForRemoteWorkspaceMode('read-write')).not.toContain('pin')
      expect(capabilitiesForRemoteWorkspaceMode('read-write')).not.toContain('yolo')
      expect(isAdminRemoteWorkspaceCapability('externalPublish')).toBe(true)
      expect(isAdminRemoteWorkspaceCapability('pin')).toBe(true)
      expect(isAdminRemoteWorkspaceCapability('yolo')).toBe(true)
      expect(describeRemoteWorkspaceCapability('externalPublish')).toMatchObject({
        label: 'Publish externally (admin)',
        adminOnly: true
      })
      expect(describeRemoteWorkspaceCapability('pin')).toMatchObject({
        label: 'Pin items (admin)',
        adminOnly: true
      })
      expect(REMOTE_WORKSPACE_CAPABILITY_DESCRIPTIONS.yolo.description).toMatch(/approval bypass/i)
    })

    it('allows admin capabilities only when an allowlist entry explicitly grants them', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-admin',
        path: '/a',
        mode: 'read-write',
        capabilities: ['monitor', 'approve', 'externalPublish', 'pin', 'yolo']
      })

      expect(
        allowlist.evaluate({ workspaceId: 'ws-admin', capability: 'externalPublish' }).allowed
      ).toBe(true)
      expect(allowlist.evaluate({ workspaceId: 'ws-admin', capability: 'pin' }).allowed).toBe(true)
      expect(allowlist.evaluate({ workspaceId: 'ws-admin', capability: 'yolo' }).allowed).toBe(
        true
      )
    })

    it('uses explicit capabilities when present instead of mode defaults', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      const entry = allowlist.upsert({
        workspaceId: 'ws-custom',
        path: '/a',
        mode: 'read-write',
        capabilities: ['monitor', 'approve']
      })
      expect(capabilitiesForRemoteWorkspaceEntry(entry)).toEqual(['monitor', 'approve'])
      expect(allowlist.evaluate({ workspaceId: 'ws-custom', capability: 'approve' }).allowed).toBe(
        true
      )
      expect(allowlist.evaluate({ workspaceId: 'ws-custom', capability: 'yolo' }).allowed).toBe(
        false
      )
    })

    it('treats an expired entry as denied', () => {
      let clock = 1000
      const allowlist = new RemoteWorkspaceAllowlist({ now: () => clock })
      allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write',
        expiresAt: 5000
      })
      // Within window.
      clock = 4999
      expect(allowlist.evaluate({ workspaceId: 'ws-1' }).allowed).toBe(true)
      // Exactly at expiry — denied (the boundary is exclusive on the right).
      clock = 5000
      const atBoundary = allowlist.evaluate({ workspaceId: 'ws-1' })
      expect(atBoundary.allowed).toBe(false)
      // After expiry.
      clock = 10_000
      const afterExpiry = allowlist.evaluate({ workspaceId: 'ws-1' })
      expect(afterExpiry.allowed).toBe(false)
      if (!afterExpiry.allowed) {
        expect(afterExpiry.reason).toMatch(/expired/i)
      }
    })
  })

  describe('fingerprint', () => {
    const seedPolicy = () => {
      const allowlist = new RemoteWorkspaceAllowlist({ now: () => 1000 })
      allowlist.upsert({
        workspaceId: 'ws-b',
        path: '/b',
        mode: 'read-only',
        capabilities: ['approve', 'monitor'],
        expiresAt: 5000
      })
      allowlist.upsert({
        workspaceId: 'ws-a',
        path: '/a',
        mode: 'read-write',
        capabilities: ['startTurn', 'approve', 'monitor']
      })
      return allowlist
    }

    it('returns a stable sha-256 policy fingerprint', () => {
      const fingerprint = seedPolicy().fingerprint()
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    })

    it('is stable when effective policy order differs', () => {
      const left = seedPolicy()
      const right = new RemoteWorkspaceAllowlist({ now: () => 9999 })
      right.upsert({
        workspaceId: 'ws-a',
        path: '/a',
        mode: 'read-write',
        capabilities: ['monitor', 'startTurn', 'approve']
      })
      right.upsert({
        workspaceId: 'ws-b',
        path: '/b',
        mode: 'read-only',
        capabilities: ['monitor', 'approve'],
        expiresAt: 5000
      })

      expect(right.fingerprint()).toBe(left.fingerprint())
    })

    it('changes when effective allowlist powers change', () => {
      const base = seedPolicy().fingerprint()

      const capabilityChanged = seedPolicy()
      capabilityChanged.upsert({
        workspaceId: 'ws-a',
        path: '/a',
        mode: 'read-write',
        capabilities: ['approve', 'monitor']
      })
      expect(capabilityChanged.fingerprint()).not.toBe(base)

      const expiryChanged = seedPolicy()
      expiryChanged.upsert({
        workspaceId: 'ws-b',
        path: '/b',
        mode: 'read-only',
        capabilities: ['approve', 'monitor'],
        expiresAt: 6000
      })
      expect(expiryChanged.fingerprint()).not.toBe(base)

      const modeChanged = seedPolicy()
      modeChanged.upsert({
        workspaceId: 'ws-b',
        path: '/b',
        mode: 'read-write',
        capabilities: ['approve', 'monitor'],
        expiresAt: 5000
      })
      expect(modeChanged.fingerprint()).not.toBe(base)
    })
  })

  describe('persistence', () => {
    let tmpDir: string
    let storagePath: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'allowlist-test-'))
      storagePath = join(tmpDir, 'allowlist.json')
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('round-trips entries through disk', () => {
      const a = new RemoteWorkspaceAllowlist({ storagePath, now: () => 1000 })
      a.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write',
        expiresAt: 9999
      })
      a.upsert({
        workspaceId: 'ws-2',
        path: '/b',
        mode: 'read-only',
        capabilities: ['monitor', 'approve']
      })

      // Reload via a fresh instance pointed at the same path.
      const b = new RemoteWorkspaceAllowlist({ storagePath, now: () => 1500 })
      expect(b.size()).toBe(2)
      expect(b.get('ws-1')?.mode).toBe('read-write')
      expect(b.get('ws-1')?.expiresAt).toBe(9999)
      expect(b.get('ws-2')?.mode).toBe('read-only')
      expect(b.get('ws-2')?.capabilities).toEqual(['monitor', 'approve'])
    })

    it('creates intermediate directories', () => {
      const deepPath = join(tmpDir, 'nested', 'a', 'b', 'allowlist.json')
      const a = new RemoteWorkspaceAllowlist({ storagePath: deepPath })
      a.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      const reloaded = new RemoteWorkspaceAllowlist({ storagePath: deepPath })
      expect(reloaded.size()).toBe(1)
    })

    it('starts empty when the file is malformed', () => {
      writeFileSync(storagePath, '{ not valid json', 'utf-8')
      const allowlist = new RemoteWorkspaceAllowlist({ storagePath })
      expect(allowlist.size()).toBe(0)
    })

    it('rewrites an empty recognized v1 policy to the universal v2 schema', () => {
      writeFileSync(storagePath, JSON.stringify({ version: 1, entries: [] }), 'utf-8')
      const allowlist = new RemoteWorkspaceAllowlist({ storagePath })
      expect(allowlist.size()).toBe(0)
      expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual({
        version: 2,
        entries: []
      })
    })

    it('fails closed without overwriting an unknown future schema', () => {
      const futurePolicy = JSON.stringify({ version: 999, entries: [{ future: true }] })
      writeFileSync(storagePath, futurePolicy, 'utf-8')
      const allowlist = new RemoteWorkspaceAllowlist({ storagePath })
      expect(allowlist.size()).toBe(0)
      expect(() =>
        allowlist.upsert({ workspaceId: 'ws-1', path: '/a', mode: 'read-write' })
      ).toThrow(/unknown schema version 999/i)
      expect(readFileSync(storagePath, 'utf-8')).toBe(futurePolicy)
    })

    it('preserves an unknown future schema even when its entries shape changed', () => {
      const futurePolicy = JSON.stringify({ version: 999, entries: { indexedById: true } })
      writeFileSync(storagePath, futurePolicy, 'utf-8')
      const allowlist = new RemoteWorkspaceAllowlist({ storagePath })
      expect(allowlist.size()).toBe(0)
      expect(() =>
        allowlist.upsert({ workspaceId: 'ws-1', path: '/a', mode: 'read-write' })
      ).toThrow(/unknown schema version 999/i)
      expect(readFileSync(storagePath, 'utf-8')).toBe(futurePolicy)
    })

    it('skips invalid entries when loading', () => {
      const goodEntry = {
        workspaceId: 'good',
        path: '/g',
        mode: 'read-write',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default'],
        createdAt: 1,
        updatedAt: 1
      }
      const badEntry = {
        workspaceId: 'bad'
        // missing required fields
      }
      writeFileSync(
        storagePath,
        JSON.stringify({ version: 1, entries: [goodEntry, badEntry] }),
        'utf-8'
      )
      const allowlist = new RemoteWorkspaceAllowlist({ storagePath })
      expect(allowlist.size()).toBe(1)
      expect(allowlist.get('good')).toBeTruthy()
      expect(allowlist.get('bad')).toBeNull()
    })

    it('persists atomic-rename-style (no tmp file leak on success)', () => {
      const a = new RemoteWorkspaceAllowlist({ storagePath })
      a.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      const onDisk = JSON.parse(readFileSync(storagePath, 'utf-8'))
      expect(onDisk.version).toBe(2)
      expect(onDisk.entries).toHaveLength(1)
      expect(onDisk.entries[0]).not.toHaveProperty('allowedProviders')
      expect(onDisk.entries[0]).not.toHaveProperty('allowedApprovalModes')
      // tmp file should be gone (renamed away)
      let tmpExists = false
      try {
        readFileSync(`${storagePath}.tmp`)
        tmpExists = true
      } catch {
        tmpExists = false
      }
      expect(tmpExists).toBe(false)
    })

    it('writes the temp-renamed policy file with owner-only permissions', () => {
      writeFileSync(storagePath, JSON.stringify({ version: 1, entries: [] }), {
        encoding: 'utf-8',
        mode: 0o666
      })
      chmodSync(storagePath, 0o666)

      const a = new RemoteWorkspaceAllowlist({ storagePath })
      a.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })

      // Windows has no POSIX owner-only mode bits; skip the 0o600 assertion there.
      if (process.platform !== 'win32') {
        expect(statSync(storagePath).mode & 0o777).toBe(0o600)
      }
      expect(() => statSync(`${storagePath}.tmp`)).toThrow()
    })

    it('is in-memory only when no storagePath is provided', () => {
      const a = new RemoteWorkspaceAllowlist()
      a.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      // A second instance with no path sees nothing.
      const b = new RemoteWorkspaceAllowlist()
      expect(b.size()).toBe(0)
    })
  })

  describe('the synthetic global scope (T71 read-only global chats)', () => {
    const withOneEntry = (): RemoteWorkspaceAllowlist => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-1',
        path: '/a',
        mode: 'read-write'
      })
      return allowlist
    }

    it('denies the global scope while the allowlist is empty (blank slate stays blank)', () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      expect(allowlist.evaluate({ workspaceId: GLOBAL_REMOTE_SCOPE })).toMatchObject({
        allowed: false,
        reason: expect.stringMatching(/allowlist is empty/i)
      })
    })

    it('grants the conversational set once a real workspace is allowlisted', () => {
      const allowlist = withOneEntry()
      expect(allowlist.evaluate({ workspaceId: GLOBAL_REMOTE_SCOPE }).allowed).toBe(true)
      // Initiate + participate: monitor/approve/answer/cancel/startTurn/steer.
      for (const capability of [
        'monitor',
        'approve',
        'answer',
        'cancel',
        'startTurn',
        'steer'
      ] as const) {
        expect(
          allowlist.evaluate({ workspaceId: GLOBAL_REMOTE_SCOPE, capability }).allowed
        ).toBe(true)
      }
      // File access, diff review, and admin caps stay denied — global chats
      // have no workspace and phone-origin turns must not touch files.
      for (const capability of [
        'diffReview',
        'fileBrowse',
        'fileRead',
        'fileWrite',
        'externalPublish',
        'pin',
        'yolo'
      ] as const) {
        expect(allowlist.evaluate({ workspaceId: GLOBAL_REMOTE_SCOPE, capability })).toMatchObject(
          { allowed: false, reason: expect.stringMatching(/no file access/i) }
        )
      }
    })

    it('clamps phone-origin turns to plan mode — every other approval mode denies', () => {
      const allowlist = withOneEntry()
      expect(
        allowlist.evaluate({
          workspaceId: GLOBAL_REMOTE_SCOPE,
          capability: 'startTurn',
          approvalMode: 'plan'
        }).allowed
      ).toBe(true)
      for (const approvalMode of ['default', 'allow-all', 'acceptEdits']) {
        expect(
          allowlist.evaluate({
            workspaceId: GLOBAL_REMOTE_SCOPE,
            capability: 'startTurn',
            approvalMode
          })
        ).toMatchObject({
          allowed: false,
          reason: expect.stringMatching(/plan mode \(no file changes\)/i)
        })
      }
      // Any provider may converse — the provider check does not apply to
      // the global scope (the plan clamp is the guarantee, not the model).
      expect(
        allowlist.evaluate({
          workspaceId: GLOBAL_REMOTE_SCOPE,
          capability: 'startTurn',
          provider: 'grok',
          approvalMode: 'plan'
        }).allowed
      ).toBe(true)
    })

    it('never lists or persists the virtual entry', () => {
      const allowlist = withOneEntry()
      expect(allowlist.size()).toBe(1)
      expect(allowlist.get(GLOBAL_REMOTE_SCOPE)).toBeNull()
      expect(allowlist.list().map((entry) => entry.workspaceId)).toEqual(['ws-1'])
    })
  })
})
