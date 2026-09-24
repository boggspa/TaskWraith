import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultDevinCredentialsPath,
  readDevinStoredCredentials,
  validateDevinApiServerUrl
} from './DevinCredentialStore'

describe('defaultDevinCredentialsPath', () => {
  const originalAppData = process.env.APPDATA
  const originalXdgDataHome = process.env.XDG_DATA_HOME

  afterEach(() => {
    if (originalAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = originalAppData
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalXdgDataHome
  })

  it('uses the default XDG data home on darwin and linux', () => {
    delete process.env.XDG_DATA_HOME
    const expected = join(homedir(), '.local', 'share', 'devin', 'credentials.toml')
    expect(defaultDevinCredentialsPath('darwin')).toBe(expected)
    expect(defaultDevinCredentialsPath('linux')).toBe(expected)
  })

  it('honors an explicit XDG_DATA_HOME, which is where `devin auth login` writes', () => {
    const xdg = join(tmpdir(), 'devin-xdg-data-home')
    process.env.XDG_DATA_HOME = xdg
    expect(defaultDevinCredentialsPath('linux')).toBe(join(xdg, 'devin', 'credentials.toml'))
    expect(defaultDevinCredentialsPath('darwin')).toBe(join(xdg, 'devin', 'credentials.toml'))
    // Windows keeps APPDATA regardless of XDG variables.
    process.env.APPDATA = join(tmpdir(), 'devin-appdata-xdg')
    expect(defaultDevinCredentialsPath('win32')).toBe(
      join(process.env.APPDATA, 'devin', 'credentials.toml')
    )
  })

  it('uses APPDATA on win32', () => {
    const appData = join(tmpdir(), 'devin-appdata-test')
    process.env.APPDATA = appData
    expect(defaultDevinCredentialsPath('win32')).toBe(join(appData, 'devin', 'credentials.toml'))
  })

  it('falls back to the roaming profile when APPDATA is unset on win32', () => {
    delete process.env.APPDATA
    expect(defaultDevinCredentialsPath('win32')).toBe(
      join(homedir(), 'AppData', 'Roaming', 'devin', 'credentials.toml')
    )
  })
})

describe('readDevinStoredCredentials', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devin-credential-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (contents: string): string => {
    const credentialsPath = join(dir, 'credentials.toml')
    writeFileSync(credentialsPath, contents, 'utf8')
    return credentialsPath
  }

  it('reports both fields null when the file is missing', () => {
    expect(readDevinStoredCredentials({ credentialsPath: join(dir, 'missing.toml') })).toEqual({
      apiKey: null,
      apiServerUrl: null
    })
  })

  it('parses and trims the flat double-quoted pairs devin auth login writes', () => {
    const credentialsPath = write(
      'windsurf_api_key = "  sk-devin-123  "\napi_server_url = "https://api.devin.example/base"\n'
    )
    expect(readDevinStoredCredentials({ credentialsPath })).toEqual({
      apiKey: 'sk-devin-123',
      apiServerUrl: 'https://api.devin.example/base'
    })
  })

  it('accepts single-quoted values', () => {
    const credentialsPath = write(
      "windsurf_api_key = 'sk-single'\napi_server_url = 'https://single.devin.example'\n"
    )
    expect(readDevinStoredCredentials({ credentialsPath })).toEqual({
      apiKey: 'sk-single',
      apiServerUrl: 'https://single.devin.example'
    })
  })

  it('accepts the api_key fallback spelling', () => {
    const credentialsPath = write('api_key = "sk-fallback"\n')
    expect(readDevinStoredCredentials({ credentialsPath })).toEqual({
      apiKey: 'sk-fallback',
      apiServerUrl: null
    })
  })

  it('prefers windsurf_api_key over api_key when both are present', () => {
    const credentialsPath = write('api_key = "sk-fallback"\nwindsurf_api_key = "sk-canonical"\n')
    expect(readDevinStoredCredentials({ credentialsPath }).apiKey).toBe('sk-canonical')
  })

  it('skips comment lines, blank lines and lines without an equals sign', () => {
    const credentialsPath = write(
      [
        '# Devin CLI credentials',
        '',
        '   ',
        '[ignored-table-header]',
        '  # indented comment',
        'windsurf_api_key = "sk-commented"',
        '',
        'api_server_url = "https://commented.devin.example"',
        '# trailing comment'
      ].join('\n')
    )
    expect(readDevinStoredCredentials({ credentialsPath })).toEqual({
      apiKey: 'sk-commented',
      apiServerUrl: 'https://commented.devin.example'
    })
  })

  it('treats empty values as absent', () => {
    const credentialsPath = write('windsurf_api_key = ""\napi_server_url = "   "\n')
    expect(readDevinStoredCredentials({ credentialsPath })).toEqual({
      apiKey: null,
      apiServerUrl: null
    })
  })

  it('refuses a file larger than 64 KiB instead of parsing it', () => {
    const credentialsPath = write(`windsurf_api_key = "sk-big"\n# ${'x'.repeat(64 * 1024)}\n`)
    expect(readDevinStoredCredentials({ credentialsPath })).toEqual({
      apiKey: null,
      apiServerUrl: null
    })
  })

  it('still parses a file of exactly 64 KiB', () => {
    const header = 'windsurf_api_key = "sk-edge"\n# '
    const contents = `${header}${'x'.repeat(64 * 1024 - header.length)}`
    expect(contents.length).toBe(64 * 1024)
    expect(readDevinStoredCredentials({ credentialsPath: write(contents) }).apiKey).toBe('sk-edge')
  })

  it('never throws on an unreadable path (a directory) and reports null', () => {
    const read = (): ReturnType<typeof readDevinStoredCredentials> =>
      readDevinStoredCredentials({ credentialsPath: dir })
    expect(read).not.toThrow()
    expect(read()).toEqual({ apiKey: null, apiServerUrl: null })
  })
})

describe('validateDevinApiServerUrl', () => {
  it('accepts https and strips the query and hash', () => {
    expect(validateDevinApiServerUrl('https://api.devin.example/v1?token=abc#frag')).toBe(
      'https://api.devin.example/v1'
    )
    expect(validateDevinApiServerUrl('https://api.devin.example')).toBe(
      'https://api.devin.example/'
    )
    expect(validateDevinApiServerUrl('  https://api.devin.example/v1  ')).toBe(
      'https://api.devin.example/v1'
    )
  })

  it('allows http only on loopback hosts', () => {
    expect(validateDevinApiServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(validateDevinApiServerUrl('http://localhost:3000/api')).toBe('http://localhost:3000/api')
    expect(validateDevinApiServerUrl('http://[::1]:8080')).toBe('http://[::1]:8080/')
  })

  it('rejects http on a non-loopback host', () => {
    expect(validateDevinApiServerUrl('http://example.com')).toBeNull()
    expect(validateDevinApiServerUrl('http://10.0.0.5:8080')).toBeNull()
    expect(validateDevinApiServerUrl('http://localhost.example.com')).toBeNull()
  })

  it('rejects embedded credentials', () => {
    expect(validateDevinApiServerUrl('https://user:pass@example.com')).toBeNull()
    expect(validateDevinApiServerUrl('https://user@example.com')).toBeNull()
    expect(validateDevinApiServerUrl('http://user:pass@127.0.0.1')).toBeNull()
  })

  it('rejects garbage, other schemes, and empty input', () => {
    expect(validateDevinApiServerUrl('not a url')).toBeNull()
    expect(validateDevinApiServerUrl('ftp://example.com')).toBeNull()
    expect(validateDevinApiServerUrl('example.com')).toBeNull()
    expect(validateDevinApiServerUrl(null)).toBeNull()
    expect(validateDevinApiServerUrl('')).toBeNull()
    expect(validateDevinApiServerUrl('   ')).toBeNull()
  })
})
