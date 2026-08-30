import os from 'os'
import { delimiter, join } from 'path'
import { describe, expect, it } from 'vitest'
import { createInteractiveTerminalEnvironment } from './InteractiveTerminalEnvironment'

describe('createInteractiveTerminalEnvironment', () => {
  it('keeps the private HOME while augmenting PATH for packaged-app CLI discovery', () => {
    const home = join(os.tmpdir(), 'taskwraith-terminal-home', 'workspace')
    const inheritedPath = join(os.tmpdir(), 'system-bin')
    const env = createInteractiveTerminalEnvironment({
      home,
      tmpDir: join(home, 'tmp'),
      inheritedEnv: { PATH: inheritedPath, SHELL: '/bin/zsh' }
    })
    const pathEntries = env.PATH.split(delimiter)

    expect(env.HOME).toBe(home)
    expect(env.TMPDIR).toBe(join(home, 'tmp'))
    expect(env.XDG_CONFIG_HOME).toBe(join(home, '.config'))
    expect(pathEntries).toContain(inheritedPath)
    expect(pathEntries).toContain(join(os.homedir(), '.kimi-code', 'bin'))
    expect(pathEntries).toContain(join(os.homedir(), '.grok', 'bin'))
  })
})
