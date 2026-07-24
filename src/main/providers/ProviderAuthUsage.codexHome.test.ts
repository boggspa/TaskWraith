import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'taskwraith-provider-auth-usage-test')
  },
  BrowserWindow: {
    fromWebContents: () => null
  },
  dialog: electron.dialog,
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

import {
  readCodexUsageCredentialLive,
  resolveCodexUsageImportPath
} from './ProviderAuthUsage'

beforeEach(() => {
  electron.dialog.showOpenDialog.mockReset()
})

describe('Codex usage paths', () => {
  it('reads the live credential from the supplied direct CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-codex-auth-'))
    const codexHome = join(root, 'codex-home')
    await mkdir(codexHome)
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'private-token',
          account_id: 'private-account'
        }
      })
    )

    await expect(readCodexUsageCredentialLive(codexHome)).resolves.toMatchObject({
      accessToken: 'private-token',
      accountId: 'private-account',
      source: 'chatgpt-auth-live'
    })
  })

  it('uses private CODEX_HOME/auth.json as the default import and never opens a picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-codex-import-'))
    const codexHome = join(root, 'codex-home')
    const authPath = join(codexHome, 'auth.json')
    await mkdir(codexHome)
    await writeFile(authPath, '{}')

    await expect(
      resolveCodexUsageImportPath({ sender: {} } as never, undefined, codexHome)
    ).resolves.toBe(authPath)
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('does not follow a symlinked private CODEX_HOME for live usage auth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-codex-auth-link-'))
    const sharedHome = join(root, 'shared')
    const codexHome = join(root, 'codex-home')
    await mkdir(sharedHome)
    await writeFile(
      join(sharedHome, 'auth.json'),
      JSON.stringify({
        tokens: { access_token: 'shared-token', account_id: 'shared-account' }
      })
    )
    await symlink(sharedHome, codexHome)

    await expect(readCodexUsageCredentialLive(codexHome)).resolves.toBeNull()
  })

  it('does not follow a symlinked auth.json inside the private CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-codex-auth-child-link-'))
    const codexHome = join(root, 'codex-home')
    const sharedAuth = join(root, 'shared-auth.json')
    await mkdir(codexHome)
    await writeFile(
      sharedAuth,
      JSON.stringify({
        tokens: { access_token: 'shared-token', account_id: 'shared-account' }
      })
    )
    await symlink(sharedAuth, join(codexHome, 'auth.json'))

    await expect(readCodexUsageCredentialLive(codexHome)).resolves.toBeNull()
  })
})
