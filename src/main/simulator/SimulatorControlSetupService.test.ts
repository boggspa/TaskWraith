import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SimulatorControlSetupService } from './SimulatorControlSetupService'

const userData = '/tmp/taskwraith-user-data'
const managedIdb = join(userData, 'simulator-control', 'python', 'bin', 'idb')
const managedPython = join(userData, 'simulator-control', 'python', 'bin', 'python')
const managedVenv = join(userData, 'simulator-control', 'python')

describe('SimulatorControlSetupService', () => {
  it('installs only the allowlisted companion and app-owned Python client', async () => {
    let companionInstalled = false
    let clientInstalled = false
    const run = vi.fn(async (executable: string, args: readonly string[]) => {
      if (executable === '/opt/homebrew/bin/brew' && args[0] === 'install') {
        companionInstalled = true
      }
      if (executable === managedPython && args[0] === '-m' && args[1] === 'pip') {
        clientInstalled = true
      }
    })
    const findHostExecutable = vi.fn((name: string) => {
      if (name === 'brew') return '/opt/homebrew/bin/brew'
      if (name === 'python3') return '/usr/bin/python3'
      if (name === 'idb_companion' && companionInstalled) return '/opt/homebrew/bin/idb_companion'
      return null
    })
    const service = new SimulatorControlSetupService({
      platform: 'darwin',
      getUserDataPath: () => userData,
      findHostExecutable,
      isExecutable: (path) => path === managedIdb && clientInstalled,
      run
    })

    expect(service.status(true)).toMatchObject({ state: 'setup_required', ready: false })

    await expect(service.setup(true)).resolves.toMatchObject({
      ok: true,
      state: 'ready',
      enabled: true,
      ready: true
    })
    expect(run).toHaveBeenCalledTimes(4)
    expect(run).toHaveBeenNthCalledWith(1, '/opt/homebrew/bin/brew', ['tap', 'facebook/fb'])
    expect(run).toHaveBeenNthCalledWith(2, '/opt/homebrew/bin/brew', ['install', 'idb-companion'])
    expect(run).toHaveBeenNthCalledWith(3, '/usr/bin/python3', ['-m', 'venv', managedVenv])
    expect(run).toHaveBeenNthCalledWith(4, managedPython, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--upgrade',
      'fb-idb'
    ])
    expect(service.resolveBinary('idb')).toBe(managedIdb)
  })

  it('does not run setup again once control is ready, including when it is disabled', async () => {
    const run = vi.fn()
    const service = new SimulatorControlSetupService({
      platform: 'darwin',
      getUserDataPath: () => userData,
      findHostExecutable: (name) =>
        name === 'idb'
          ? '/usr/local/bin/idb'
          : name === 'idb_companion'
            ? '/usr/local/bin/idb_companion'
            : null,
      isExecutable: () => false,
      run
    })

    await expect(service.setup(false)).resolves.toMatchObject({
      ok: true,
      state: 'disabled',
      enabled: false,
      ready: true
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('lets the disabled state take precedence over an optional missing setup', () => {
    const service = new SimulatorControlSetupService({
      platform: 'darwin',
      getUserDataPath: () => userData,
      findHostExecutable: () => null,
      isExecutable: () => false
    })

    expect(service.status(false)).toMatchObject({
      enabled: false,
      ready: false,
      state: 'disabled'
    })
  })

  it('reports an unsupported host without attempting a local install', async () => {
    const run = vi.fn()
    const service = new SimulatorControlSetupService({
      platform: 'linux',
      getUserDataPath: () => userData,
      run
    })

    await expect(service.setup(true)).resolves.toMatchObject({
      ok: false,
      state: 'unsupported',
      supported: false
    })
    expect(run).not.toHaveBeenCalled()
  })
})
