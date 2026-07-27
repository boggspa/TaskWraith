import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCursorGlobalBrokerRegistrationTransaction,
  type CursorGlobalBrokerTransactionFs
} from './CursorGlobalBrokerRegistrationTransaction'
import {
  CursorGlobalBrokerRegistryInstallError,
  CursorGlobalBrokerRegistryLeaseCoordinator,
  cursorGlobalBrokerRegistrationKey,
  normalizeCursorGlobalBrokerRegistrationDescriptor
} from './CursorGlobalBrokerRegistryLease'
import { CURSOR_MCP_SERVER_NAME, CURSOR_SCOPED_MCP_SERVER_NAME } from './CursorMcpBridge'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    nodeFs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture(initial?: unknown) {
  const root = nodeFs.realpathSync(
    nodeFs.mkdtempSync(join(tmpdir(), 'taskwraith-cursor-registry-'))
  )
  temporaryRoots.push(root)
  const registryDirectory = join(root, '.cursor')
  const registryPath = join(registryDirectory, 'mcp.json')
  nodeFs.mkdirSync(registryDirectory, { recursive: true, mode: 0o700 })
  if (initial !== undefined) {
    nodeFs.writeFileSync(registryPath, `${JSON.stringify(initial, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
  }
  return { root, registryDirectory, registryPath }
}

function descriptor(token = 'new-token') {
  return {
    brokerEntries: {
      [CURSOR_MCP_SERVER_NAME]: {
        command: '/Applications/TaskWraith',
        args: ['/bridge.cjs', '--socket', token],
        env: { TASKWRAITH_PARENT_PROVIDER: 'cursor' }
      }
    },
    removeServerNames: [CURSOR_SCOPED_MCP_SERVER_NAME]
  }
}

function context(registryPath: string, token = 'new-token') {
  const normalized = normalizeCursorGlobalBrokerRegistrationDescriptor(descriptor(token))
  return {
    resourceKey: registryPath,
    registrationKey: cursorGlobalBrokerRegistrationKey(normalized),
    descriptor: normalized
  }
}

function readRegistry(registryPath: string): Record<string, any> {
  return JSON.parse(nodeFs.readFileSync(registryPath, 'utf8'))
}

function fsAdapter(hooks?: {
  beforeRead?: (count: number, path: string) => void
  rename?: (count: number, from: string, to: string) => void
  remove?: (count: number, path: string, options: { force?: boolean }) => void
}): CursorGlobalBrokerTransactionFs {
  let readCount = 0
  let renameCount = 0
  let removeCount = 0
  return {
    lstatSync: (path) => nodeFs.lstatSync(path),
    realpathSync: (path) => nodeFs.realpathSync(path),
    readFileSync: (path, encoding) => {
      readCount += 1
      hooks?.beforeRead?.(readCount, path)
      return nodeFs.readFileSync(path, encoding)
    },
    mkdirSync: (path, options) => nodeFs.mkdirSync(path, options),
    openSync: (path, flags, mode) => nodeFs.openSync(path, flags, mode),
    writeFileSync: (file, data, options) => nodeFs.writeFileSync(file, data, options),
    fchmodSync: (file, mode) => nodeFs.fchmodSync(file, mode),
    // These tests force `fsyncDirectory: true` to exercise the durability
    // branch, but fsync on a DIRECTORY handle is EPERM on Windows — which is
    // why production defaults the flag to `process.platform !== 'win32'` and
    // never takes this path there. Tolerate the same errnos the codebase's
    // other directory-fsync helpers already swallow, so the branch stays under
    // test everywhere instead of failing for a reason no user can hit.
    fsyncSync: (file) => {
      try {
        nodeFs.fsyncSync(file)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== 'EPERM' && code !== 'EINVAL' && code !== 'EISDIR') throw error
      }
    },
    closeSync: (file) => nodeFs.closeSync(file),
    renameSync: (from, to) => {
      renameCount += 1
      if (hooks?.rename) hooks.rename(renameCount, from, to)
      else nodeFs.renameSync(from, to)
    },
    rmSync: (path, options) => {
      removeCount += 1
      if (hooks?.remove) hooks.remove(removeCount, path, options)
      else nodeFs.rmSync(path, options)
    }
  }
}

function transaction(
  registryPath: string,
  registryDirectory: string,
  fs: CursorGlobalBrokerTransactionFs = fsAdapter()
) {
  return createCursorGlobalBrokerRegistrationTransaction({
    fs,
    registryPath,
    registryDirectory,
    fsyncDirectory: true
  })
}

describe('CursorGlobalBrokerRegistrationTransaction', () => {
  it('atomically installs owned entries while preserving unrelated global state', () => {
    const { registryPath, registryDirectory } = fixture({
      theme: 'dark',
      mcpServers: {
        user: { command: 'user-server' },
        [CURSOR_SCOPED_MCP_SERVER_NAME]: { command: 'obsolete' }
      }
    })
    const tx = transaction(registryPath, registryDirectory)

    const installation = tx.install(context(registryPath))
    const result = readRegistry(registryPath)
    expect(result.theme).toBe('dark')
    expect(result.mcpServers.user).toEqual({ command: 'user-server' })
    expect(result.mcpServers[CURSOR_SCOPED_MCP_SERVER_NAME]).toBeUndefined()
    expect(result.mcpServers[CURSOR_MCP_SERVER_NAME].args).toContain('new-token')
    expect(installation.onLastRelease()).toEqual({ outcome: 'retained-persistent' })
    expect(nodeFs.readdirSync(registryDirectory)).toEqual(['mcp.json'])
  })

  it('preserves the registry portable permission bits across atomic replacement', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { user: { command: 'user-server' } }
    })
    nodeFs.chmodSync(registryPath, 0o660)
    // Assert the invariant this test is actually about — that atomic
    // replacement PRESERVES whatever mode the file had — rather than a literal
    // 0o660, which Windows never reports because chmod there only toggles the
    // read-only bit. Comparing before against after holds on every platform.
    const modeBefore = nodeFs.statSync(registryPath).mode & 0o777

    transaction(registryPath, registryDirectory).install(context(registryPath))

    expect(nodeFs.statSync(registryPath).mode & 0o777).toBe(modeBefore)
  })

  it('keeps durable matching registration as a no-op', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: descriptor().brokerEntries
    })
    const fs = fsAdapter()
    const rename = vi.spyOn(fs, 'renameSync')
    const tx = transaction(registryPath, registryDirectory, fs)

    const installation = tx.install(context(registryPath))
    expect(rename).not.toHaveBeenCalled()
    expect(installation.onLastRelease()).toEqual({ outcome: 'retained-persistent' })
  })

  it('creates a missing registry through the same atomic path', () => {
    const { registryPath, registryDirectory } = fixture()
    const tx = createCursorGlobalBrokerRegistrationTransaction({
      // Raw nodeFs here would call fsync on a DIRECTORY handle, which is EPERM
      // on Windows; the shared adapter tolerates that the same way production's
      // own directory-fsync helpers do. This test is about creating a missing
      // registry, not about the durability syscall.
      fs: fsAdapter(),
      registryPath,
      registryDirectory,
      fsyncDirectory: true
    })

    tx.install(context(registryPath))
    expect(readRegistry(registryPath).mcpServers[CURSOR_MCP_SERVER_NAME]).toBeDefined()
    expect(nodeFs.readdirSync(registryDirectory)).toEqual(['mcp.json'])
  })

  it('retries on pre-rename byte drift and preserves the newly observed user server', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { user: { command: 'first' } }
    })
    let injected = false
    const fs = fsAdapter({
      beforeRead: (count, path) => {
        // Read #1 is the attempt snapshot; read #2 is the exact-byte CAS check.
        if (count !== 2 || injected) return
        injected = true
        const current = readRegistry(path)
        current.mcpServers.late = { command: 'late-user-server' }
        nodeFs.writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`)
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)

    tx.install(context(registryPath))
    const result = readRegistry(registryPath)
    expect(result.mcpServers.user).toEqual({ command: 'first' })
    expect(result.mcpServers.late).toEqual({ command: 'late-user-server' })
    expect(result.mcpServers[CURSOR_MCP_SERVER_NAME]).toBeDefined()
  })

  it('verifies original state when atomic rename fails before commit', () => {
    const originalBroker = { command: 'old-broker' }
    const { registryPath, registryDirectory } = fixture({
      mcpServers: {
        user: { command: 'user' },
        [CURSOR_MCP_SERVER_NAME]: originalBroker
      }
    })
    const fs = fsAdapter({
      rename: () => {
        throw new Error('rename refused')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }
    expect(tx.onInstallFailure(failure, ctx)).toEqual({ outcome: 'restored-verified' })
    expect(readRegistry(registryPath).mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual(originalBroker)
  })

  it('rolls back an ambiguous committed rename and restores removed owned aliases', () => {
    const oldBroker = { command: 'old-broker' }
    const oldScoped = { command: 'old-scoped' }
    const { registryPath, registryDirectory } = fixture({
      mcpServers: {
        user: { command: 'user' },
        [CURSOR_MCP_SERVER_NAME]: oldBroker,
        [CURSOR_SCOPED_MCP_SERVER_NAME]: oldScoped
      }
    })
    const fs = fsAdapter({
      rename: (count, from, to) => {
        nodeFs.renameSync(from, to)
        if (count === 1) throw new Error('commit acknowledgement lost')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }
    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'restore-attempted-unverified'
    })
    const restored = readRegistry(registryPath)
    expect(restored.mcpServers.user).toEqual({ command: 'user' })
    expect(restored.mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual(oldBroker)
    expect(restored.mcpServers[CURSOR_SCOPED_MCP_SERVER_NAME]).toEqual(oldScoped)
  })

  it('restores an originally absent registry after an ambiguous committed create', () => {
    const { registryPath, registryDirectory } = fixture()
    const fs = fsAdapter({
      rename: (count, from, to) => {
        nodeFs.renameSync(from, to)
        if (count === 1) throw new Error('create acknowledgement lost')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }

    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'restore-attempted-unverified'
    })
    expect(nodeFs.existsSync(registryPath)).toBe(false)
  })

  it('preserves unrelated external edits observed after an ambiguous commit', () => {
    const oldBroker = { command: 'old-broker' }
    const { registryPath, registryDirectory } = fixture({
      mcpServers: {
        user: { command: 'user' },
        [CURSOR_MCP_SERVER_NAME]: oldBroker
      }
    })
    const fs = fsAdapter({
      rename: (count, from, to) => {
        nodeFs.renameSync(from, to)
        if (count !== 1) return
        const current = readRegistry(to)
        current.externalSetting = { preserved: true }
        current.mcpServers.late = { command: 'late-user-server' }
        nodeFs.writeFileSync(to, `${JSON.stringify(current, null, 2)}\n`)
        throw new Error('ambiguous after external edit')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }
    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'restore-attempted-unverified'
    })
    const restored = readRegistry(registryPath)
    expect(restored.externalSetting).toEqual({ preserved: true })
    expect(restored.mcpServers.late).toEqual({ command: 'late-user-server' })
    expect(restored.mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual(oldBroker)
  })

  it('retries rollback CAS when an unrelated edit lands before rollback rename', () => {
    const oldBroker = { command: 'old-broker' }
    const { registryPath, registryDirectory } = fixture({
      mcpServers: {
        user: { command: 'user' },
        [CURSOR_MCP_SERVER_NAME]: oldBroker
      }
    })
    let ambiguousCommit = false
    let rollbackDriftInjected = false
    const fs = fsAdapter({
      rename: (count, from, to) => {
        nodeFs.renameSync(from, to)
        if (count === 1) {
          ambiguousCommit = true
          throw new Error('ambiguous commit')
        }
      },
      beforeRead: (_count, path) => {
        // Once failure recovery has read its base, the next read is the
        // rollback transaction's exact-byte CAS check.
        if (!ambiguousCommit || rollbackDriftInjected) return
        rollbackDriftInjected = true
        const current = readRegistry(path)
        current.mcpServers.duringRollback = { command: 'preserve-me' }
        nodeFs.writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`)
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }
    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'restore-attempted-unverified'
    })
    const restored = readRegistry(registryPath)
    expect(restored.mcpServers.duringRollback).toEqual({ command: 'preserve-me' })
    expect(restored.mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual(oldBroker)
  })

  it('never rolls back an external desired value when no target rename was invoked', () => {
    const oldBroker = { command: 'old-broker' }
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: oldBroker }
    })
    let externalWriteInjected = false
    const fs = fsAdapter({
      beforeRead: (count, path) => {
        if (count !== 2 || externalWriteInjected) return
        externalWriteInjected = true
        nodeFs.writeFileSync(
          path,
          `${JSON.stringify(
            {
              externalSetting: 'preserve-me',
              mcpServers: descriptor().brokerEntries
            },
            null,
            2
          )}\n`
        )
      }
    })
    const rename = vi.spyOn(fs, 'renameSync')
    const tx = createCursorGlobalBrokerRegistrationTransaction({
      fs,
      registryPath,
      registryDirectory,
      maxCasAttempts: 1,
      fsyncDirectory: true
    })
    const ctx = context(registryPath)

    let failure: unknown
    expect(() => {
      try {
        tx.install(ctx)
      } catch (error) {
        failure = error
        throw error
      }
    }).toThrow('changed during all 1 bounded CAS attempts')

    expect(rename).not.toHaveBeenCalled()
    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'restore-attempted-unverified'
    })
    const preserved = readRegistry(registryPath)
    expect(preserved.externalSetting).toBe('preserve-me')
    expect(preserved.mcpServers[CURSOR_MCP_SERVER_NAME].args).toContain('new-token')
  })

  it('refuses rollback when an external writer changed an owned key', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: {
        user: { command: 'user' },
        [CURSOR_MCP_SERVER_NAME]: { command: 'old-broker' }
      }
    })
    const foreignOwnedValue = { command: 'external-owned-edit' }
    const fs = fsAdapter({
      rename: (count, from, to) => {
        nodeFs.renameSync(from, to)
        if (count !== 1) return
        const current = readRegistry(to)
        current.mcpServers[CURSOR_MCP_SERVER_NAME] = foreignOwnedValue
        nodeFs.writeFileSync(to, `${JSON.stringify(current, null, 2)}\n`)
        throw new Error('ambiguous after owned edit')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }
    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('no longer matched')
    })
    expect(readRegistry(registryPath).mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual(foreignOwnedValue)
  })

  it('does not call an exact-byte inode replacement restored-verified', () => {
    const original = {
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: { command: 'old-broker' } }
    }
    const { registryPath, registryDirectory } = fixture(original)
    const originalBytes = nodeFs.readFileSync(registryPath, 'utf8')
    const originalInode = nodeFs.statSync(registryPath).ino
    const fs = fsAdapter({
      rename: (_count, _from, to) => {
        const externalTemporaryPath = join(registryDirectory, 'external-replacement.tmp')
        nodeFs.writeFileSync(externalTemporaryPath, originalBytes, { mode: 0o600 })
        nodeFs.renameSync(externalTemporaryPath, to)
        throw new Error('transaction rename refused after external replacement')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }

    expect(nodeFs.statSync(registryPath).ino).not.toBe(originalInode)
    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'restore-attempted-unverified'
    })
    expect(nodeFs.readFileSync(registryPath, 'utf8')).toBe(originalBytes)
  })

  it('reports cleanup failure when a credential-bearing temporary file cannot be removed', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: { command: 'old-broker' } }
    })
    const fs = fsAdapter({
      rename: () => {
        throw new Error('rename refused')
      },
      remove: () => {
        throw new Error('temporary unlink refused')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const ctx = context(registryPath)

    let failure: unknown
    try {
      tx.install(ctx)
    } catch (error) {
      failure = error
    }

    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('temporary file')
    })
    expect(nodeFs.readdirSync(registryDirectory).some((name) => name.endsWith('.tmp'))).toBe(true)
  })

  it('refuses invalid JSON without replacing the user file', () => {
    const { registryPath, registryDirectory } = fixture()
    const invalid = '{ this is not valid json'
    nodeFs.writeFileSync(registryPath, invalid)
    const tx = transaction(registryPath, registryDirectory)
    const ctx = context(registryPath)

    let failure: unknown
    expect(() => {
      try {
        tx.install(ctx)
      } catch (error) {
        failure = error
        throw error
      }
    }).toThrow('not valid JSON')
    expect(tx.onInstallFailure(failure, ctx)).toMatchObject({
      outcome: 'cleanup-failed'
    })
    expect(nodeFs.readFileSync(registryPath, 'utf8')).toBe(invalid)
  })

  it.each(['1e400', '9007199254740993', '0.100000000000000005', '-0'])(
    'refuses a JSON number that cannot survive lossless rewrite: %s',
    (numberToken) => {
      const { registryPath, registryDirectory } = fixture()
      const original = `{"mcpServers":{"user":{"value":${numberToken}}}}\n`
      nodeFs.writeFileSync(registryPath, original)
      const tx = transaction(registryPath, registryDirectory)

      expect(() => tx.install(context(registryPath))).toThrow('losslessly rewritten')
      expect(nodeFs.readFileSync(registryPath, 'utf8')).toBe(original)
    }
  )

  it('refuses duplicate JSON object keys rather than collapsing unrelated state', () => {
    const { registryPath, registryDirectory } = fixture()
    const original = '{"setting":{"preserve":"first","\\u0070reserve":"second"},"mcpServers":{}}\n'
    nodeFs.writeFileSync(registryPath, original)
    const tx = transaction(registryPath, registryDirectory)

    expect(() => tx.install(context(registryPath))).toThrow('duplicate object key')
    expect(nodeFs.readFileSync(registryPath, 'utf8')).toBe(original)
  })

  it('rejects a symlinked registry target before mutation', () => {
    const { root, registryPath, registryDirectory } = fixture()
    const target = join(root, 'user-owned.json')
    nodeFs.writeFileSync(target, '{"mcpServers":{}}\n')
    nodeFs.symlinkSync(target, registryPath)
    const tx = transaction(registryPath, registryDirectory)

    expect(() => tx.install(context(registryPath))).toThrow('unsafe target')
    expect(nodeFs.readFileSync(target, 'utf8')).toBe('{"mcpServers":{}}\n')
  })

  it('rejects a symlinked registry-directory ancestor before mutation', () => {
    const { root, registryPath, registryDirectory } = fixture({
      mcpServers: { user: { command: 'user-owned' } }
    })
    const aliasDirectory = join(root, 'cursor-alias')
    nodeFs.symlinkSync(registryDirectory, aliasDirectory)
    const aliasRegistryPath = join(aliasDirectory, 'mcp.json')
    const tx = transaction(aliasRegistryPath, aliasDirectory)

    expect(() => tx.install(context(aliasRegistryPath))).toThrow('symlinked ancestor')
    expect(readRegistry(registryPath).mcpServers.user).toEqual({ command: 'user-owned' })
  })

  it('binds install and failure callbacks to the lease resource and descriptor', () => {
    const { root, registryPath, registryDirectory } = fixture({
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: { command: 'old-broker' } }
    })
    const tx = transaction(registryPath, registryDirectory)
    const validContext = context(registryPath)

    expect(() =>
      tx.install({ ...validContext, resourceKey: join(root, 'other-mcp.json') })
    ).toThrow('does not match the lease resource')
    expect(() =>
      tx.install({ ...validContext, registrationKey: `${validContext.registrationKey}-wrong` })
    ).toThrow('does not match the lease registration key')
  })

  it('rejects a mismatched failure callback without poisoning matching recovery', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: { command: 'old-broker' } }
    })
    const fs = fsAdapter({
      rename: (count, from, to) => {
        nodeFs.renameSync(from, to)
        if (count === 1) throw new Error('ambiguous commit')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const validContext = context(registryPath)

    let failure: unknown
    try {
      tx.install(validContext)
    } catch (error) {
      failure = error
    }

    expect(tx.onInstallFailure(failure, context(registryPath, 'other-token'))).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('context did not match')
    })
    expect(tx.onInstallFailure(failure, validContext)).toMatchObject({
      outcome: 'restore-attempted-unverified'
    })
    expect(readRegistry(registryPath).mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual({
      command: 'old-broker'
    })
  })

  it('rejects a descriptor that tries to claim a user-owned global server name', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { user: { command: 'user-owned' } }
    })
    const tx = transaction(registryPath, registryDirectory)
    const unsafeDescriptor = {
      brokerEntries: { user: { command: 'replacement' } },
      removeServerNames: [] as string[]
    }
    const normalized = normalizeCursorGlobalBrokerRegistrationDescriptor(unsafeDescriptor)
    const unsafeContext = {
      resourceKey: registryPath,
      registrationKey: cursorGlobalBrokerRegistrationKey(normalized),
      descriptor: normalized
    }

    expect(() => tx.install(unsafeContext)).toThrow('non-owned server name')
    expect(readRegistry(registryPath).mcpServers.user).toEqual({ command: 'user-owned' })
  })

  it('exposes callbacks directly consumable by the global registry lease', async () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { user: { command: 'user' } }
    })
    const tx = transaction(registryPath, registryDirectory)
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()

    const lease = await coordinator.acquire({
      registryPath,
      ...descriptor(),
      install: tx.install,
      onInstallFailure: tx.onInstallFailure
    })
    const release = await lease.release()
    expect(release.cleanup).toEqual({ outcome: 'retained-persistent' })
    expect(readRegistry(registryPath).mcpServers.user).toEqual({ command: 'user' })
  })

  it('can be reused sequentially without carrying stale recovery state', () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { user: { command: 'user' } }
    })
    const tx = transaction(registryPath, registryDirectory)

    tx.install(context(registryPath, 'first-token'))
    tx.install(context(registryPath, 'second-token'))

    expect(readRegistry(registryPath).mcpServers[CURSOR_MCP_SERVER_NAME].args).toContain(
      'second-token'
    )
  })

  it('carries honest unverified transactional rollback through a lease install error', async () => {
    const { registryPath, registryDirectory } = fixture({
      mcpServers: { [CURSOR_MCP_SERVER_NAME]: { command: 'old' } }
    })
    const fs = fsAdapter({
      rename: (count, from, to) => {
        nodeFs.renameSync(from, to)
        if (count === 1) throw new Error('ambiguous commit')
      }
    })
    const tx = transaction(registryPath, registryDirectory, fs)
    const coordinator = new CursorGlobalBrokerRegistryLeaseCoordinator()

    const error = await coordinator
      .acquire({
        registryPath,
        ...descriptor(),
        install: tx.install,
        onInstallFailure: tx.onInstallFailure
      })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(CursorGlobalBrokerRegistryInstallError)
    expect(error).toMatchObject({
      cleanup: { outcome: 'restore-attempted-unverified' }
    })
    expect(readRegistry(registryPath).mcpServers[CURSOR_MCP_SERVER_NAME]).toEqual({
      command: 'old'
    })
  })
})
