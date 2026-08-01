import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runningAppBundleMutationBlockReason } from './RunningAppBundleMutationGuard'

const workspace = '/Users/example/AGBench'
const packagedExecutable =
  '/Users/example/AGBench/dist/mac-universal/TaskWraith.app/Contents/MacOS/TaskWraith'

function check(
  command: unknown,
  options: {
    executablePath?: string
    packageScripts?: Record<string, unknown>
  } = {}
): string | null {
  return runningAppBundleMutationBlockReason({
    command,
    cwd: workspace,
    executablePath: options.executablePath || packagedExecutable,
    packageScripts: options.packageScripts
  })
}

describe('RunningAppBundleMutationGuard', () => {
  it('blocks removing or moving an ancestor of the running app bundle', () => {
    expect(check('rm -rf dist dist-debug')).toContain('currently hosting this run')
    expect(check(['rm', '-rf', 'dist/mac-universal'])).toContain('currently hosting this run')
    expect(check('mv dist /tmp/agbench-dist-park')).toContain('currently hosting this run')
  })

  it('blocks deleting a path inside the running app bundle', () => {
    expect(check('rm -f dist/mac-universal/TaskWraith.app/Contents/Resources/app.asar')).toContain(
      'currently hosting this run'
    )
  })

  it('allows cleanup of sibling output that does not contain the running app', () => {
    expect(check('rm -rf dist-debug')).toBeNull()
    expect(check('rm -rf out')).toBeNull()
    expect(check('npm test')).toBeNull()
  })

  it('allows dist cleanup when TaskWraith is running outside dist', () => {
    expect(
      check('rm -rf dist', {
        executablePath: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'
      })
    ).toBeNull()
    expect(
      check('node scripts/clean-dist.cjs dist', {
        executablePath:
          '/Users/example/AGBench/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      })
    ).toBeNull()
  })

  it('blocks the clean-dist script default and explicit targets', () => {
    expect(check('node scripts/clean-dist.cjs')).toContain('currently hosting this run')
    expect(check('node scripts/clean-dist.cjs dist')).toContain('currently hosting this run')
  })

  it('follows package-script indirection only far enough to find live dist cleanup', () => {
    const packageScripts = {
      'clean:dist': 'node scripts/clean-dist.cjs dist',
      'build:mac': 'npm run clean:dist && npm run build',
      build: 'electron-vite build',
      test: 'vitest run'
    }

    expect(check('npm run clean:dist', { packageScripts })).toContain('currently hosting this run')
    expect(check('npm run build:mac', { packageScripts })).toContain('currently hosting this run')
    expect(check('npm run build', { packageScripts })).toBeNull()
    expect(check('npm test', { packageScripts })).toBeNull()
  })

  it('handles recursive package scripts without looping', () => {
    expect(
      check('npm run first', {
        packageScripts: { first: 'npm run second', second: 'npm run first' }
      })
    ).toBeNull()
  })

  it('blocks the repository packaging chain but permits its CI chain', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, unknown> }

    expect(check('npm run build:mac', { packageScripts: manifest.scripts })).toContain(
      'currently hosting this run'
    )
    expect(check('npm run ci', { packageScripts: manifest.scripts })).toBeNull()
  })
})
