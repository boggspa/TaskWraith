import { describe, expect, it } from 'vitest'
import {
  defaultTaskWraithDevUserDataPath,
  defaultTaskWraithUserDataPath,
  taskWraithControlSocketPath
} from './taskWraithControlPaths.node'

describe('TaskWraith local-control paths', () => {
  it('distinguishes release, normal dev, and named dev instances', () => {
    const home = '/Users/example'
    expect(defaultTaskWraithUserDataPath('darwin', {}, home)).toBe(
      '/Users/example/Library/Application Support/taskwraith'
    )
    expect(defaultTaskWraithDevUserDataPath('darwin', {}, home)).toBe(
      '/Users/example/Library/Application Support/TaskWraith Dev'
    )
    expect(
      defaultTaskWraithDevUserDataPath('darwin', { TASKWRAITH_INSTANCE_ID: 'Codex QA !!' }, home)
    ).toBe('/Users/example/Library/Application Support/TaskWraith Dev CodexQA')
  })

  it('honours an explicit userData path for either build kind', () => {
    const env = { TASKWRAITH_USER_DATA: '/private/taskwraith-host' }
    expect(defaultTaskWraithUserDataPath('linux', env, '/home/example')).toBe(
      '/private/taskwraith-host'
    )
    expect(defaultTaskWraithDevUserDataPath('linux', env, '/home/example')).toBe(
      '/private/taskwraith-host'
    )
  })

  it('keeps POSIX sockets short and isolates them by userData identity', () => {
    const longPath = `/var/folders/${'very-long-segment/'.repeat(12)}TaskWraith Dev`
    const first = taskWraithControlSocketPath(longPath, 'darwin')
    const second = taskWraithControlSocketPath(`${longPath} 2`, 'darwin')
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThan(104)
    expect(first).not.toBe(second)
    expect(first).toMatch(/taskwraith-control-v1\.sock$/)
  })
})
