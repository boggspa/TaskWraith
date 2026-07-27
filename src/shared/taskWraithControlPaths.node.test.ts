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

  it('uses a bounded opaque named pipe on Windows', () => {
    const first = taskWraithControlSocketPath('C:\\Users\\Ada\\TaskWraith', 'win32')
    const second = taskWraithControlSocketPath('C:\\Users\\Ada\\TaskWraith Dev', 'win32')
    expect(first.startsWith('\\\\.\\pipe\\taskwraith-control-')).toBe(true)
    expect(first.slice(-16)).toMatch(/^[a-f0-9]{16}$/)
    expect(first).not.toContain('Ada')
    expect(first).not.toBe(second)
  })
})
