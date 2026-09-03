import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_ACP_ARCHIVE_ENV,
  ANTIGRAVITY_ACP_DEST_ENV,
  ANTIGRAVITY_ACP_DOWNLOAD_TIMEOUT_MS,
  ANTIGRAVITY_ACP_EXTRACT_TIMEOUT_MS,
  ANTIGRAVITY_ACP_WINDOWS_EXPAND_COMMAND,
  AntigravityAcpInstallTransportError,
  assertAntigravityAcpZipEntriesSafe,
  buildAntigravityAcpExtractInvocation,
  createAntigravityAcpDownloadArchive,
  createAntigravityAcpExtractArchive,
  createAntigravityAcpSpawnProcess,
  isAntigravityAcpPathInside,
  listAntigravityAcpZipEntryNames,
  type AntigravityAcpExecFile
} from './AntigravityAcpInstallTransport'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50

const TEMP_DIR = '/tmp/tw-agy-acp-zip-test'
const ARCHIVE_PATH = join(TEMP_DIR, 'archive.zip')
const DEST_DIR = '/opt/taskwraith/agy-acp'

function makeZip(names: string[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from('payload')
    const local = Buffer.alloc(30 + nameBuf.length + data.length)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    data.copy(local, 30 + nameBuf.length)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(localOffset, 42)
    nameBuf.copy(central, 46)

    localParts.push(local)
    centralParts.push(central)
    localOffset += local.length
  }
  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDir, eocd])
}

const SAFE_ZIP = makeZip(['agy_acp_server.par'])
const NESTED_ZIP = makeZip(['nested/agy_acp_server.par'])

type ExecCall = {
  file: string
  args: readonly string[]
  options: {
    env?: NodeJS.ProcessEnv
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
  }
}

function enoent(tool: string): NodeJS.ErrnoException {
  const error = new Error(`spawn ${tool} ENOENT`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

function extractHarness(
  overrides: Parameters<typeof createAntigravityAcpExtractArchive>[0] & {
    execFileImpl?: AntigravityAcpExecFile
  } = {}
) {
  const execCalls: ExecCall[] = []
  const rmCalls: string[] = []
  const writeCalls: string[] = []
  const { execFileImpl, ...rest } = overrides
  const extract = createAntigravityAcpExtractArchive({
    platform: 'darwin',
    execFile: async (file, args, options) => {
      execCalls.push({ file, args: [...args], options })
      if (execFileImpl) return execFileImpl(file, args, options)
      return undefined
    },
    mkdtemp: async () => TEMP_DIR,
    tmpdir: () => '/tmp',
    writeFile: async (filePath) => {
      writeCalls.push(filePath)
    },
    mkdir: async () => undefined,
    rm: async (dirPath) => {
      rmCalls.push(dirPath)
    },
    realpath: async (filePath) => filePath,
    readdir: async () => ['agy_acp_server.par'],
    pathExists: async (filePath) =>
      filePath.endsWith('agy_acp_server.par') || filePath.endsWith('agy_acp_server.exe'),
    ...rest
  })
  return { extract, execCalls, rmCalls, writeCalls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('makeZip fixture / listAntigravityAcpZipEntryNames', () => {
  it('parses the concrete entry names written into the fixture', () => {
    expect(listAntigravityAcpZipEntryNames(SAFE_ZIP)).toEqual(['agy_acp_server.par'])
    expect(listAntigravityAcpZipEntryNames(NESTED_ZIP)).toEqual(['nested/agy_acp_server.par'])
    expect(listAntigravityAcpZipEntryNames(makeZip(['/etc/x', '../../x']))).toEqual([
      '/etc/x',
      '../../x'
    ])
  })

  it('rejects a non-Buffer body before any extract launch', () => {
    expect(() => listAntigravityAcpZipEntryNames('not-a-buffer' as unknown as Buffer)).toThrow(
      AntigravityAcpInstallTransportError
    )
    try {
      listAntigravityAcpZipEntryNames('not-a-buffer' as unknown as Buffer)
    } catch (error) {
      expect(error).toMatchObject({ code: 'extract-failed' })
      expect((error as Error).message).toMatch(/not a valid ZIP/)
      expect((error as Error).message).toMatch(/not launched/)
    }
  })
})

describe('buildAntigravityAcpExtractInvocation platform argv matrix', () => {
  it('darwin uses ditto with the exact argv array [-x, -k, archive, dest]', () => {
    const invocation = buildAntigravityAcpExtractInvocation('darwin', ARCHIVE_PATH, DEST_DIR)
    expect(invocation.file).toBe('ditto')
    expect(invocation.args).toEqual(['-x', '-k', ARCHIVE_PATH, DEST_DIR])
    expect(invocation.args).toHaveLength(4)
    expect(invocation.env).toBeUndefined()
  })

  it('linux uses unzip with the exact argv array [-o, archive, -d, dest]', () => {
    const invocation = buildAntigravityAcpExtractInvocation('linux', ARCHIVE_PATH, DEST_DIR)
    expect(invocation.file).toBe('unzip')
    expect(invocation.args).toEqual(['-o', ARCHIVE_PATH, '-d', DEST_DIR])
    expect(invocation.args).toHaveLength(4)
    expect(invocation.env).toBeUndefined()
  })

  it('win32 Expand-Archive receives paths only via env vars, never interpolated into the command', () => {
    const archivePath = 'C:\\evil;calc.exe'
    const destDir = 'D:\\dest & notepad.exe'
    const parentEnv = { PATH: '/Windows/System32', KEEP: 'yes' }
    const invocation = buildAntigravityAcpExtractInvocation(
      'win32',
      archivePath,
      destDir,
      parentEnv
    )
    expect(invocation.file).toBe('powershell.exe')
    expect(invocation.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ANTIGRAVITY_ACP_WINDOWS_EXPAND_COMMAND
    ])
    expect(invocation.args[3]).toBe(
      'Expand-Archive -LiteralPath $env:TASKWRAITH_ANTIGRAVITY_ACP_ARCHIVE -DestinationPath $env:TASKWRAITH_ANTIGRAVITY_ACP_DEST -Force'
    )
    expect(invocation.args[3]).toContain(`$env:${ANTIGRAVITY_ACP_ARCHIVE_ENV}`)
    expect(invocation.args[3]).toContain(`$env:${ANTIGRAVITY_ACP_DEST_ENV}`)
    expect(invocation.args[3]).not.toContain(archivePath)
    expect(invocation.args[3]).not.toContain(destDir)
    expect(invocation.args[3]).not.toContain('evil')
    expect(invocation.args[3]).not.toContain('calc')
    expect(invocation.args[3]).not.toContain('notepad')
    expect(invocation.env).toEqual({
      PATH: '/Windows/System32',
      KEEP: 'yes',
      [ANTIGRAVITY_ACP_ARCHIVE_ENV]: archivePath,
      [ANTIGRAVITY_ACP_DEST_ENV]: destDir
    })
  })

  it('unsupported platform fails closed with honest copy and does not return a launch', () => {
    expect(() => buildAntigravityAcpExtractInvocation('freebsd', ARCHIVE_PATH, DEST_DIR)).toThrow(
      AntigravityAcpInstallTransportError
    )
    try {
      buildAntigravityAcpExtractInvocation('freebsd', ARCHIVE_PATH, DEST_DIR)
    } catch (error) {
      expect(error).toMatchObject({ code: 'extract-failed' })
      expect((error as Error).message).toContain('freebsd')
      expect((error as Error).message).toMatch(/no system unzip tool is configured/)
      expect((error as Error).message).toMatch(/not launched/)
    }
  })
})

describe('createAntigravityAcpExtractArchive', () => {
  it('launches darwin ditto with the exact argv array observed on execFile', async () => {
    const { extract, execCalls } = extractHarness({ platform: 'darwin' })
    await extract(SAFE_ZIP, DEST_DIR)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].file).toBe('ditto')
    expect(execCalls[0].args).toEqual(['-x', '-k', ARCHIVE_PATH, DEST_DIR])
    expect(execCalls[0].options.timeout).toBe(ANTIGRAVITY_ACP_EXTRACT_TIMEOUT_MS)
    expect(execCalls[0].options.windowsHide).toBe(true)
  })

  it('launches linux unzip with the exact argv array observed on execFile', async () => {
    const { extract, execCalls } = extractHarness({
      platform: 'linux',
      readdir: async () => ['agy_acp_server.par']
    })
    await extract(SAFE_ZIP, DEST_DIR)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].file).toBe('unzip')
    expect(execCalls[0].args).toEqual(['-o', ARCHIVE_PATH, '-d', DEST_DIR])
  })

  it('launches win32 powershell with env-var path indirection, not interpolated argv paths', async () => {
    const { extract, execCalls } = extractHarness({
      platform: 'win32',
      readdir: async () => ['agy_acp_server.exe'],
      pathExists: async (filePath) => filePath.endsWith('agy_acp_server.exe')
    })
    await extract(makeZip(['agy_acp_server.exe']), DEST_DIR)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].file).toBe('powershell.exe')
    expect(execCalls[0].args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ANTIGRAVITY_ACP_WINDOWS_EXPAND_COMMAND
    ])
    expect(execCalls[0].args[3]).not.toContain(ARCHIVE_PATH)
    expect(execCalls[0].args[3]).not.toContain(DEST_DIR)
    expect(execCalls[0].options.env?.[ANTIGRAVITY_ACP_ARCHIVE_ENV]).toBe(ARCHIVE_PATH)
    expect(execCalls[0].options.env?.[ANTIGRAVITY_ACP_DEST_ENV]).toBe(DEST_DIR)
  })

  it('unsupported platform fails closed with honest copy and never launches a tool', async () => {
    const { extract, execCalls, rmCalls } = extractHarness({ platform: 'freebsd' })
    const error = await extract(SAFE_ZIP, DEST_DIR).then(
      () => null,
      (reason: unknown) => reason as Error
    )
    expect(error).toMatchObject({
      name: 'AntigravityAcpInstallTransportError',
      code: 'extract-failed'
    })
    expect(error?.message).toContain('freebsd')
    expect(error?.message).toMatch(/not launched/)
    expect(execCalls).toHaveLength(0)
    expect(rmCalls).toEqual([TEMP_DIR])
  })

  it('missing system tool (ENOENT) fails closed naming the tool and never skips extraction', async () => {
    const { extract, execCalls } = extractHarness({
      platform: 'darwin',
      execFileImpl: async (file) => {
        throw enoent(file)
      }
    })
    const error = await extract(SAFE_ZIP, DEST_DIR).then(
      () => null,
      (reason: unknown) => reason as AntigravityAcpInstallTransportError
    )
    expect(error).toMatchObject({
      name: 'AntigravityAcpInstallTransportError',
      code: 'tool-missing'
    })
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].file).toBe('ditto')
    expect(execCalls[0].args).toEqual(['-x', '-k', ARCHIVE_PATH, DEST_DIR])
    expect(error?.message).toContain('ditto')
    expect(error?.message).toMatch(/was not found/)
    expect(error?.message).toMatch(/not launched/)
    expect(error?.message).not.toMatch(/skip/i)
  })

  it('cleans up the temp archive directory in finally after a successful extract', async () => {
    const { extract, rmCalls, writeCalls, execCalls } = extractHarness()
    await extract(SAFE_ZIP, DEST_DIR)
    expect(writeCalls).toEqual([ARCHIVE_PATH])
    expect(execCalls).toHaveLength(1)
    expect(rmCalls).toEqual([TEMP_DIR])
  })

  it('cleans up the temp archive directory in finally after extract failure', async () => {
    const { extract, rmCalls, execCalls } = extractHarness({
      execFileImpl: async () => {
        throw new Error('unzip exploded')
      }
    })
    await expect(extract(SAFE_ZIP, DEST_DIR)).rejects.toMatchObject({ code: 'extract-failed' })
    expect(execCalls).toHaveLength(1)
    expect(rmCalls).toEqual([TEMP_DIR])
  })
})

describe('ZIP-SLIP containment', () => {
  it('isAntigravityAcpPathInside accepts nested paths and refuses parents and absolutes', () => {
    expect(isAntigravityAcpPathInside(DEST_DIR, join(DEST_DIR, 'nested/agy_acp_server.par'))).toBe(
      true
    )
    expect(isAntigravityAcpPathInside(DEST_DIR, DEST_DIR)).toBe(true)
    expect(isAntigravityAcpPathInside(DEST_DIR, '/etc/x')).toBe(false)
    expect(isAntigravityAcpPathInside(DEST_DIR, join(DEST_DIR, '..', 'outside'))).toBe(false)
  })

  it('refuses an absolute zip entry /etc/x and does not launch extract', async () => {
    expect(() => assertAntigravityAcpZipEntriesSafe(['/etc/x'], DEST_DIR)).toThrow(
      AntigravityAcpInstallTransportError
    )
    try {
      assertAntigravityAcpZipEntriesSafe(['/etc/x'], DEST_DIR)
    } catch (error) {
      expect(error).toMatchObject({ code: 'zip-slip' })
      expect((error as Error).message).toMatch(/escapes the extract directory/)
      expect((error as Error).message).toMatch(/not launched/)
    }
    const { extract, execCalls, rmCalls } = extractHarness()
    await expect(extract(makeZip(['/etc/x']), DEST_DIR)).rejects.toMatchObject({
      code: 'zip-slip'
    })
    expect(execCalls).toHaveLength(0)
    expect(rmCalls).toHaveLength(0)
  })

  it('refuses a drive-letter zip entry C:\\x and does not launch extract', async () => {
    const driveLetter = 'C:\\x'
    expect(() => assertAntigravityAcpZipEntriesSafe([driveLetter], DEST_DIR)).toThrow(
      /zip-slip|escapes/
    )
    try {
      assertAntigravityAcpZipEntriesSafe([driveLetter], DEST_DIR)
    } catch (error) {
      expect(error).toMatchObject({ code: 'zip-slip' })
    }
    const { extract, execCalls } = extractHarness({ platform: 'win32' })
    await expect(extract(makeZip([driveLetter]), DEST_DIR)).rejects.toMatchObject({
      code: 'zip-slip'
    })
    expect(execCalls).toHaveLength(0)
  })

  it('refuses a traversing zip entry ../../x and does not launch extract', async () => {
    expect(() => assertAntigravityAcpZipEntriesSafe(['../../x'], DEST_DIR)).toThrow(
      AntigravityAcpInstallTransportError
    )
    try {
      assertAntigravityAcpZipEntriesSafe(['../../x'], DEST_DIR)
    } catch (error) {
      expect(error).toMatchObject({ code: 'zip-slip' })
      expect((error as Error).message).toMatch(/escapes the extract directory/)
    }
    const { extract, execCalls, rmCalls } = extractHarness()
    await expect(extract(makeZip(['../../x']), DEST_DIR)).rejects.toMatchObject({
      code: 'zip-slip'
    })
    expect(execCalls).toHaveLength(0)
    expect(rmCalls).toHaveLength(0)
  })

  it('accepts a normal nested entry and launches extract', async () => {
    expect(() =>
      assertAntigravityAcpZipEntriesSafe(['nested/agy_acp_server.par'], DEST_DIR)
    ).not.toThrow()
    const { extract, execCalls } = extractHarness({
      readdir: async () => ['nested', 'nested/agy_acp_server.par']
    })
    await extract(NESTED_ZIP, DEST_DIR)
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].file).toBe('ditto')
    expect(execCalls[0].args).toEqual(['-x', '-k', ARCHIVE_PATH, DEST_DIR])
  })
})

describe('createAntigravityAcpDownloadArchive', () => {
  it('rejects a non-2xx response and never returns a body', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      arrayBuffer: async () => Uint8Array.from([1]).buffer
    })) as unknown as typeof fetch
    const download = createAntigravityAcpDownloadArchive({ fetchImpl })
    const error = await download('https://dl.google.com/agy.zip').then(
      () => null,
      (reason: unknown) => reason as Error
    )
    expect(error).toMatchObject({
      name: 'AntigravityAcpInstallTransportError',
      code: 'download-failed'
    })
    expect(error?.message).toContain('HTTP 503')
    expect(error?.message).toMatch(/not launched/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('applies AbortSignal.timeout so a hung download cannot stall install', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('follow')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([9, 8, 7, 6]).buffer
      }
    }) as unknown as typeof fetch
    const download = createAntigravityAcpDownloadArchive({
      fetchImpl,
      timeoutMs: 12_345
    })
    const bytes = await download('https://dl.google.com/agy.zip')
    expect(bytes.equals(Buffer.from([9, 8, 7, 6]))).toBe(true)
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(timeoutSpy).toHaveBeenCalledWith(12_345)
    expect(timeoutSpy.mock.calls[0][0]).toBe(12_345)
  })

  it('uses the 60s default AbortSignal.timeout when timeoutMs is omitted', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([1]).buffer
    })) as unknown as typeof fetch
    await createAntigravityAcpDownloadArchive({ fetchImpl })('https://dl.google.com/agy.zip')
    expect(timeoutSpy).toHaveBeenCalledTimes(1)
    expect(timeoutSpy).toHaveBeenCalledWith(ANTIGRAVITY_ACP_DOWNLOAD_TIMEOUT_MS)
    expect(ANTIGRAVITY_ACP_DOWNLOAD_TIMEOUT_MS).toBe(60_000)
  })

  it('maps TimeoutError / AbortError onto the timeout code', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    const fetchImpl = vi.fn(async () => {
      throw timeout
    }) as unknown as typeof fetch
    await expect(
      createAntigravityAcpDownloadArchive({ fetchImpl })('https://dl.google.com/agy.zip')
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects an empty download body', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0)
    })) as unknown as typeof fetch
    await expect(
      createAntigravityAcpDownloadArchive({ fetchImpl })('https://dl.google.com/agy.zip')
    ).rejects.toMatchObject({
      code: 'download-failed',
      message: expect.stringMatching(/empty/)
    })
  })

  it('rejects a non-http(s) URL without calling fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      createAntigravityAcpDownloadArchive({ fetchImpl })('file:///etc/passwd')
    ).rejects.toMatchObject({ code: 'download-failed' })
    expect(fetchImpl).toHaveBeenCalledTimes(0)
  })
})

describe('createAntigravityAcpSpawnProcess', () => {
  it('passes an argv array with shell false and stdio pipes for ACP JSON-RPC', () => {
    const spawn = vi.fn(() => ({ pid: 4242 }))
    const factory = createAntigravityAcpSpawnProcess('/opt/agy_acp_server.par', ['--uid=501'], {
      spawn: spawn as unknown as typeof import('node:child_process').spawn
    })
    const child = factory()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls).toHaveLength(1)
    const [binary, argv, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { stdio: unknown; shell: unknown; windowsHide: unknown }
    ]
    expect(binary).toBe('/opt/agy_acp_server.par')
    expect(Array.isArray(argv)).toBe(true)
    expect(argv).toEqual(['--uid=501'])
    expect(argv).toHaveLength(1)
    expect(options.shell).toBe(false)
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(options.windowsHide).toBe(true)
    expect(child).toEqual({ pid: 4242 })
  })

  it('fails closed on an empty binary path and does not spawn', () => {
    const spawn = vi.fn()
    expect(() =>
      createAntigravityAcpSpawnProcess('  ', ['--uid=1'], {
        spawn: spawn as unknown as typeof import('node:child_process').spawn
      })
    ).toThrow(AntigravityAcpInstallTransportError)
    try {
      createAntigravityAcpSpawnProcess('', [])
    } catch (error) {
      expect(error).toMatchObject({ code: 'spawn-failed' })
      expect((error as Error).message).toMatch(/not launched/)
    }
    expect(spawn).toHaveBeenCalledTimes(0)
  })
})

describe('source provenance', () => {
  it('contains no hardcoded 64-hex digest, no shell: true, and no npm zip/decompress import', async () => {
    const source = await readFile(join(__dirname, 'AntigravityAcpInstallTransport.ts'), 'utf8')
    expect(source).not.toMatch(/[a-fA-F0-9]{64}/)
    expect(source).not.toMatch(/\bshell:\s*true\b/)
    expect(source).toMatch(/shell:\s*false/)
    expect(source).not.toMatch(
      /from ['"][^'"]*(?:jszip|adm-zip|yauzl|unzipper|extract-zip|decompress|fflate)[^'"]*['"]/
    )
    expect(source).not.toMatch(
      /require\(['"][^'"]*(?:jszip|adm-zip|yauzl|unzipper|extract-zip|decompress)[^'"]*['"]\)/
    )
  })
})
