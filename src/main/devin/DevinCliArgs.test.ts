import { describe, expect, it } from 'vitest'
import {
  DEVIN_ACP_SUBCOMMAND,
  DEVIN_BINARY_NAME,
  DEVIN_CREDENTIAL_ENV_VARS,
  DEVIN_READ_ONLY_PROMPT_PREAMBLE,
  DEVIN_WRITE_MODE_PROMPT_PREAMBLE,
  applyDevinPromptPreamble,
  buildDevinAcpCliArgs,
  devinCredentialEnvScrubbed,
  devinWriteCapable,
  scrubDevinCredentialEnv
} from './DevinCliArgs'

describe('devin binary + argv', () => {
  it('targets the devin CLI and its acp subcommand', () => {
    // `devin` is the whole CLI and `devin acp` is its stdio ACP server. A bare
    // `devin` waits on a terminal a managed run does not have.
    expect(DEVIN_BINARY_NAME).toBe('devin')
    expect(DEVIN_ACP_SUBCOMMAND).toBe('acp')
  })

  it('builds exactly [acp] when no model is selected', () => {
    expect(buildDevinAcpCliArgs()).toEqual(['acp'])
    expect(buildDevinAcpCliArgs(null)).toEqual(['acp'])
    expect(buildDevinAcpCliArgs(undefined)).toEqual(['acp'])
  })

  it('appends --model with the trimmed id', () => {
    expect(buildDevinAcpCliArgs('devin-3')).toEqual(['acp', '--model', 'devin-3'])
    expect(buildDevinAcpCliArgs('  devin-3  ')).toEqual(['acp', '--model', 'devin-3'])
  })

  it('never emits a --model flag for a blank id', () => {
    // `--model ""` would reach the CLI as an invalid model rather than "use
    // the default".
    expect(buildDevinAcpCliArgs('')).toEqual(['acp'])
    expect(buildDevinAcpCliArgs('   ')).toEqual(['acp'])
  })
})

describe('devinWriteCapable', () => {
  it('treats plan as read-only, including with stray whitespace', () => {
    expect(devinWriteCapable('plan')).toBe(false)
    expect(devinWriteCapable('plan ')).toBe(false)
    expect(devinWriteCapable(' plan')).toBe(false)
  })

  it('treats an empty or missing approval mode as read-only', () => {
    expect(devinWriteCapable('')).toBe(false)
    expect(devinWriteCapable('   ')).toBe(false)
    expect(devinWriteCapable(null)).toBe(false)
    expect(devinWriteCapable(undefined)).toBe(false)
  })

  it('treats other modes as write-capable', () => {
    expect(devinWriteCapable('default')).toBe(true)
    expect(devinWriteCapable('auto')).toBe(true)
  })
})

describe('credential env scrubbing', () => {
  it('covers exactly the three Devin key spellings', () => {
    expect([...DEVIN_CREDENTIAL_ENV_VARS]).toEqual([
      'WINDSURF_API_KEY',
      'DEVIN_API_KEY',
      'windsurf_api_key'
    ])
  })

  it('removes every Devin credential var and keeps unrelated keys', () => {
    const scrubbed = scrubDevinCredentialEnv({
      WINDSURF_API_KEY: 'wk-live',
      DEVIN_API_KEY: 'dk-live',
      windsurf_api_key: 'lk-live',
      PATH: '/usr/bin',
      HOME: '/Users/x'
    })
    expect(scrubbed.WINDSURF_API_KEY).toBeUndefined()
    expect(scrubbed.DEVIN_API_KEY).toBeUndefined()
    expect(scrubbed.windsurf_api_key).toBeUndefined()
    expect(scrubbed).toEqual({ PATH: '/usr/bin', HOME: '/Users/x' })
  })

  it('returns a new object and never mutates the caller env', () => {
    // The caller's env is usually the shared resolved-env object; deleting in
    // place would scrub unrelated concurrent launches.
    const original = { WINDSURF_API_KEY: 'wk-live', DEVIN_API_KEY: 'dk-live', PATH: '/usr/bin' }
    const scrubbed = scrubDevinCredentialEnv(original)
    expect(scrubbed).not.toBe(original)
    expect(original.WINDSURF_API_KEY).toBe('wk-live')
    expect(original.DEVIN_API_KEY).toBe('dk-live')
  })

  it('reports clean only when all three spellings are absent or empty', () => {
    expect(devinCredentialEnvScrubbed({ PATH: '/usr/bin' })).toBe(true)
    expect(
      devinCredentialEnvScrubbed({ WINDSURF_API_KEY: '', DEVIN_API_KEY: '', windsurf_api_key: '' })
    ).toBe(true)
    expect(devinCredentialEnvScrubbed({ WINDSURF_API_KEY: 'wk' })).toBe(false)
    expect(devinCredentialEnvScrubbed({ DEVIN_API_KEY: 'dk' })).toBe(false)
    expect(devinCredentialEnvScrubbed({ windsurf_api_key: 'lk' })).toBe(false)
    expect(devinCredentialEnvScrubbed({ WINDSURF_API_KEY: '', windsurf_api_key: 'lk' })).toBe(false)
  })

  it('round-trips: a scrubbed env reports clean', () => {
    const dirty = {
      WINDSURF_API_KEY: 'wk',
      DEVIN_API_KEY: 'dk',
      windsurf_api_key: 'lk',
      HOME: '/Users/x'
    }
    expect(devinCredentialEnvScrubbed(dirty)).toBe(false)
    expect(devinCredentialEnvScrubbed(scrubDevinCredentialEnv(dirty))).toBe(true)
  })
})

describe('prompt preamble', () => {
  it('prepends the read-only preamble, a blank line, then the prompt verbatim', () => {
    const prompt = 'Do the thing.\n\nSecond paragraph, kept byte-for-byte.'
    expect(applyDevinPromptPreamble(prompt, false)).toBe(
      `${DEVIN_READ_ONLY_PROMPT_PREAMBLE}\n\n${prompt}`
    )
  })

  it('prepends the write preamble for a write-capable seat', () => {
    const prompt = 'Do the thing.'
    const write = applyDevinPromptPreamble(prompt, true)
    expect(write).toBe(`${DEVIN_WRITE_MODE_PROMPT_PREAMBLE}\n\n${prompt}`)
    expect(write).not.toContain('READ-ONLY mode')
    expect(write).toContain('reviewed by the host before it runs')
    expect(write).not.toBe(applyDevinPromptPreamble(prompt, false))
  })

  it('tells a read-only seat which reads are allowed and not to dead-end', () => {
    // A seat whose write is refused mid-turn can hard-stop with no answer; the
    // steer is preventive UX, and the host gate remains the actual safety floor.
    const readOnly = applyDevinPromptPreamble('x', false)
    expect(readOnly).toContain('READ-ONLY mode')
    expect(readOnly).toContain(
      'read-only shell commands such as ls, cat, grep, find, and git log / status / diff'
    )
    expect(readOnly).toContain('do NOT end your turn')
  })
})
