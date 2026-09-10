import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { terminateExactChild } = require('./electronChildSession.cjs')

describe('terminateExactChild stray reap', () => {
  it('SIGKILLs leftover listeners on the owned CDP ports after the child exits', async () => {
    const kills: Array<{ pid: number; sig: string }> = []
    const fake = new EventEmitter()
    Object.assign(fake, {
      pid: 77,
      remoteDebuggingPort: 9656,
      mainInspectorPort: 10056,
      kill(sig: string) {
        if (sig === 'SIGTERM') fake.emit('exit', 0, sig)
        return true
      }
    })
    const result = await terminateExactChild(fake, {
      waitMs: 20,
      sleep: async () => undefined,
      killPid: (pid: number, sig: string) => {
        kills.push({ pid, sig })
      },
      listListeningPidsForPort: async (port: number) => (port === 9656 ? [32051] : []),
      listPidsMatchingCommandNeedle: async () => [12560],
      userDataPath: '/private/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1'
    })
    expect(result.strayKills).toEqual([
      { pid: 32051, reason: 'listen:9656' },
      { pid: 12560, reason: 'userData-command' }
    ])
    expect(kills).toEqual([
      { pid: 32051, sig: 'SIGKILL' },
      { pid: 12560, sig: 'SIGKILL' }
    ])
  })
})
