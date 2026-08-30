import { describe, expect, it } from 'vitest'
import { resolveHostExternalLaunch } from './HostExternalLaunchResolver'

describe('HostExternalLaunchResolver', () => {
  const payloadVersion = `sha256:${'a'.repeat(64)}`

  it('resolves packaged Node/Host CLI paths without Electron arguments', async () => {
    const node = '/App/Resources/tui-runtime/darwin-arm64/node'
    const cli = '/App/Resources/host/host-runtime/cli.js'
    await expect(
      resolveHostExternalLaunch({
        packaged: true,
        profilePath: '/profiles/a',
        resourcesPath: '/App/Resources',
        platform: 'darwin',
        architecture: 'arm64',
        env: { ELECTRON_RUN_AS_NODE: '1' },
        resolvePayloadVersion: () => payloadVersion,
        pathExists: async (path) => path === node || path === cli
      })
    ).resolves.toEqual({
      executable: node,
      args: [cli, 'serve', '--mode', 'production', '--profile', '/profiles/a'],
      cwd: '/App/Resources/host/host-runtime',
      env: {},
      payloadVersion
    })
  })

  it('rejects Electron as a development Node executable', async () => {
    await expect(
      resolveHostExternalLaunch({
        packaged: false,
        profilePath: '/profiles/a',
        repoRoot: '/repo',
        platform: 'darwin',
        nodeExecutable: '/repo/Electron',
        resolvePayloadVersion: () => payloadVersion,
        pathExists: async () => true
      })
    ).rejects.toThrow('ordinary Node')
  })

  it.each([
    ['win32', 'x64', 'C:\\App\\resources', 'C:\\profiles\\a', 'node.exe'],
    ['linux', 'arm64', '/app/resources', '/profiles/a', 'node']
  ] as const)(
    'resolves packaged %s-%s runtime',
    async (platform, architecture, resourcesPath, profilePath, nodeName) => {
      const apiPath = platform === 'win32' ? '\\' : '/'
      const node = `${resourcesPath}${apiPath}tui-runtime${apiPath}${platform}-${architecture}${apiPath}${nodeName}`
      const cli = `${resourcesPath}${apiPath}host${apiPath}host-runtime${apiPath}cli.js`
      const result = await resolveHostExternalLaunch({
        packaged: true,
        profilePath,
        resourcesPath,
        platform,
        architecture,
        resolvePayloadVersion: () => payloadVersion,
        pathExists: async (value) => value === node || value === cli
      })
      expect(result?.executable).toBe(node)
      expect(result?.args).toEqual([cli, 'serve', '--mode', 'production', '--profile', profilePath])
      expect(result?.payloadVersion).toBe(payloadVersion)
    }
  )
})
