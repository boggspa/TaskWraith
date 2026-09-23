import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { HOST_REGISTRY_ROOT_ENV } from '../src/host-runtime/HostRegistry'

const require = createRequire(import.meta.url)
const {
  argvCarriesIsolation,
  buildSmokeLaunchArgv,
  buildSmokeOpenArgs,
  createSmokeUserDataPath
}: {
  argvCarriesIsolation: (argv: readonly string[]) => boolean
  buildSmokeLaunchArgv: (smokeUserDataPath: string, temporaryRoot?: string) => string[]
  buildSmokeOpenArgs: (
    appRoot: string,
    launchArgs: readonly string[],
    registryRoot: unknown
  ) => string[]
  createSmokeUserDataPath: (temporaryRoot?: string) => string
} = require('./smoke-host-boot-electron.cjs')

/**
 * The `open` argv of the Electron boot smoke, checked statically: nothing
 * here launches the app. `open` hands its own environment to nothing, so
 * `--env` is the only way the smoke's registry root reaches the app and the
 * external Host it spawns.
 */
describe('buildSmokeOpenArgs', () => {
  const appRoot = '/Applications/TaskWraith.app'
  const registryRoot = join(tmpdir(), 'taskwraith-host-boot-smoke-registry-x')

  it('opens a new instance, waits for it, and hands it the registry root before the app path', () => {
    const launchArgs = buildSmokeLaunchArgv(createSmokeUserDataPath(tmpdir()), tmpdir())
    const argv = buildSmokeOpenArgs(appRoot, launchArgs, registryRoot)
    expect(argv).toEqual([
      '-n',
      '-W',
      '--env',
      `${HOST_REGISTRY_ROOT_ENV}=${registryRoot}`,
      appRoot,
      '--args',
      ...launchArgs
    ])
    // `open` reads its own options only before the application path, and
    // passes everything after `--args` to the app untouched.
    expect(argv.indexOf('--env')).toBeLessThan(argv.indexOf(appRoot))
    expect(argv.slice(argv.indexOf('--args') + 1)).toEqual(launchArgs)
    expect(argvCarriesIsolation(argv.slice(argv.indexOf('--args') + 1))).toBe(true)
  })

  it('refuses a registry root that is missing or relative', () => {
    for (const bad of [undefined, null, '', 'hosts', './hosts']) {
      expect(() => buildSmokeOpenArgs(appRoot, [], bad)).toThrow(
        'smoke Host registry root must be absolute'
      )
    }
  })
})
