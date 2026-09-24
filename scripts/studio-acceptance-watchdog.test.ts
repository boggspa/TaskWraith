import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Row = {
  pid: number
  ppid: number
  pgid: number
  command: string
  birth: string
  token?: string
}

function controllerFixture() {
  vi.useFakeTimers()
  let rows: Row[] = []
  let launchEnv: Record<string, string> = {}
  const messages: any[] = []
  const files = new Map<string, string>()
  const executable = '/work/TaskWraith Debug.app/Contents/MacOS/TaskWraith Debug'
  const birth = 'Thu Sep 24 02:00:00 2026'
  const home = '/work/acceptance/home'
  const child = Object.assign(new EventEmitter(), {
    pid: 1001,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn()
  })
  const fakeProcess = Object.assign(new EventEmitter(), {
    pid: 9000,
    platform: 'darwin',
    env: {},
    connected: true,
    send: (message: unknown) => messages.push(message),
    exit: vi.fn(),
    kill: vi.fn((pid: number, signal: string | number) => {
      if (signal === 0 && !rows.some((row) => row.pgid === -pid)) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
    })
  })
  const spawn = vi.fn((_command, _args, options) => {
    launchEnv = options.env
    return child
  })
  const spawnSync = vi.fn((_command, args: string[]) => {
    if (args.includes('-axww')) {
      return {
        status: 0,
        stdout: rows.map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.command}`).join('\n')
      }
    }
    const row = rows.find((row) => row.pid === Number(args[args.indexOf('-p') + 1]))
    if (!row) return { status: 1, stdout: '' }
    return {
      status: 0,
      stdout: args.includes('eww')
        ? `${row.command} TASKWRAITH_STUDIO_WATCHDOG_TOKEN=${row.token ?? ''}\n`
        : `${row.pid} ${row.pgid} ${row.birth}\n`
    }
  })
  const module = { exports: {} }
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'studio-acceptance-watchdog.cjs'), 'utf8'),
    {
      module,
      require: Object.assign(
        (name: string) => {
          if (name === 'node:path') return path
          if (name === 'node:crypto') return crypto
          if (name === 'node:child_process') return { spawn, spawnSync }
          if (name === 'node:fs')
            return {
              realpathSync: (file: string) => file,
              mkdirSync: vi.fn(),
              writeFileSync: (file: string, data: string) => files.set(file, data),
              renameSync: (from: string, to: string) => files.set(to, files.get(from)!)
            }
          throw new Error(`unexpected module ${name}`)
        },
        { main: module }
      ),
      process: fakeProcess,
      setTimeout,
      clearTimeout,
      setImmediate,
      Date
    }
  )
  const env = {
    HOME: home,
    TASKWRAITH_INSTANCE_ID: 'studioAdopt01',
    IOS_REMOTE_TRUE: '0',
    TASKWRAITH_STUDIO_COMPANION: '1'
  }
  fakeProcess.emit('message', {
    type: 'launch',
    spec: {
      kind: 'electron',
      command: '/usr/bin/open',
      cwd: '/work',
      receiptPath: '/work/receipt.json',
      env,
      timeoutMs: 30000,
      forceAfterMs: 50,
      launchServicesExecutable: executable,
      args: [
        '-n',
        '-F',
        '-W',
        ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
        '/work/TaskWraith Debug.app',
        '--args',
        '--use-mock-keychain'
      ]
    }
  })
  const app = (): Row => ({
    pid: 2000,
    ppid: 1,
    pgid: 2000,
    command: `${executable} --use-mock-keychain`,
    birth,
    token: launchEnv.TASKWRAITH_STUDIO_WATCHDOG_TOKEN
  })
  return {
    app,
    executable,
    messages,
    fakeProcess,
    child,
    spawn,
    setRows: (next: Row[]) => {
      rows = next
    },
    adopt: (patch = {}) =>
      fakeProcess.emit('message', {
        type: 'adopt-launch-services',
        requestId: 'adopt-1',
        pid: 2000,
        pgid: 2000,
        ...patch
      }),
    stop: () => {
      fakeProcess.emit('message', { type: 'stop' })
      child.emit('exit', 0, null)
    },
    receipt: () => JSON.parse(files.get('/work/receipt.json')!)
  }
}

afterEach(() => vi.useRealTimers())

describe('watchdog LaunchServices adoption custody (fake processes)', () => {
  it('retains the exact app when its home-bearing helper exits before the first scan', () => {
    const fixture = controllerFixture()
    const openArgs = fixture.spawn.mock.calls[0][1] as string[]
    const token = fixture.app().token!
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(openArgs.slice(openArgs.indexOf('/work/TaskWraith Debug.app') - 2)).toEqual([
      '--env',
      `TASKWRAITH_STUDIO_WATCHDOG_TOKEN=${token}`,
      '/work/TaskWraith Debug.app',
      '--args',
      '--use-mock-keychain'
    ])
    fixture.setRows([fixture.app()])
    fixture.adopt()
    expect(fixture.messages).toContainEqual(
      expect.objectContaining({ type: 'adopted', requestId: 'adopt-1', pid: 2000, pgid: 2000 })
    )
    fixture.stop()
    expect(fixture.fakeProcess.kill).toHaveBeenCalledWith(-2000, 'SIGTERM')
    expect(fixture.messages.some((message) => message.type === 'terminal')).toBe(false)
    fixture.setRows([])
    vi.advanceTimersByTime(100)
    expect(fixture.receipt()).toMatchObject({
      status: 'reaped',
      launchServicesAdoption: { pid: 2000, pgid: 2000, groupExitVerified: true }
    })
    expect(JSON.stringify(fixture.receipt())).not.toContain(token)
  })

  it.each(['wrong token', 'wrong executable', 'wrong pgid', 'extra field'])(
    'rejects untrusted adoption with %s without signaling that group',
    (damage) => {
      const fixture = controllerFixture()
      const app = fixture.app()
      if (damage === 'wrong token') app.token = 'foreign-token'
      if (damage === 'wrong executable')
        app.command = '/Applications/Foreign.app/Contents/MacOS/Foreign'
      if (damage === 'wrong pgid') app.pgid = 3000
      fixture.setRows([app])
      fixture.adopt(damage === 'extra field' ? { trusted: true } : {})
      expect(fixture.messages).toContainEqual(
        expect.objectContaining({ type: 'adoption-rejected', requestId: 'adopt-1' })
      )
      expect(fixture.fakeProcess.kill).not.toHaveBeenCalledWith(-2000, 'SIGTERM')
      expect(fixture.messages.some((message) => message.type === 'adopted')).toBe(false)
    }
  )

  it('refuses a clean terminal receipt when adoption never completed', () => {
    const fixture = controllerFixture()
    fixture.stop()
    vi.advanceTimersByTime(5200)
    expect(fixture.receipt()).toMatchObject({
      status: 'reap_incomplete',
      detachedGroupExitVerified: false
    })
  })

  it('does not fall back to HOME argv as authority after an untrusted adoption', () => {
    const fixture = controllerFixture()
    fixture.setRows([
      {
        ...fixture.app(),
        command: `${fixture.app().command} --user-data-dir=/work/acceptance/home/profile`,
        token: 'foreign-token'
      }
    ])
    fixture.adopt()
    fixture.stop()
    vi.advanceTimersByTime(5200)
    expect(fixture.fakeProcess.kill).not.toHaveBeenCalledWith(-2000, 'SIGTERM')
    expect(fixture.fakeProcess.kill).not.toHaveBeenCalledWith(-2000, 'SIGKILL')
    expect(fixture.receipt()).toMatchObject({
      status: 'reap_incomplete',
      detachedGroupExitVerified: false
    })
  })

  it('still cleans up a current launch-owned detached helper group', () => {
    const fixture = controllerFixture()
    fixture.setRows([fixture.app()])
    fixture.adopt()
    fixture.setRows([
      fixture.app(),
      {
        ...fixture.app(),
        pid: 3000,
        pgid: 3000,
        command: '/work/helper --home=/work/acceptance/home'
      }
    ])
    fixture.stop()
    expect(fixture.fakeProcess.kill).toHaveBeenCalledWith(-3000, 'SIGTERM')
    fixture.setRows([])
    vi.advanceTimersByTime(100)
    expect(fixture.receipt()).toMatchObject({ status: 'reaped', detachedGroupExitVerified: true })
  })

  it('requires the adopted group to exit even after its app leader exits', () => {
    const fixture = controllerFixture()
    const helper = { ...fixture.app(), pid: 2001, command: '/work/electron-helper' }
    fixture.setRows([fixture.app(), helper])
    fixture.adopt()
    fixture.setRows([helper])
    fixture.stop()
    vi.advanceTimersByTime(5200)
    expect(fixture.fakeProcess.kill).toHaveBeenCalledWith(-2000, 'SIGTERM')
    expect(fixture.receipt()).toMatchObject({
      status: 'reap_incomplete',
      launchServicesAdoption: { groupExitVerified: false }
    })
  })

  it('fails closed after an adopted PID is reused instead of authorizing its new process', () => {
    const fixture = controllerFixture()
    fixture.setRows([fixture.app()])
    fixture.adopt()
    fixture.setRows([{ ...fixture.app(), birth: 'Thu Sep 24 02:01:00 2026' }])
    fixture.stop()
    vi.advanceTimersByTime(5200)
    expect(fixture.fakeProcess.kill).not.toHaveBeenCalledWith(-2000, 'SIGTERM')
    expect(fixture.fakeProcess.kill).not.toHaveBeenCalledWith(-2000, 'SIGKILL')
    expect(fixture.receipt()).toMatchObject({
      status: 'reap_incomplete',
      detachedGroupExitVerified: false
    })
  })
})
