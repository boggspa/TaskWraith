import { describe, expect, it } from 'vitest'
import {
  PROVIDER_DIAGNOSTIC_LOG_PREFIX,
  formatProviderDiagnosticNotice,
  isProviderDiagnosticLogLine,
  readProviderDiagnosticNotice
} from './providerDiagnosticNotice'

const KIMI_ADMISSION = {
  type: 'provider_diagnostic',
  provider: 'kimi',
  source: 'kimi-runtime-admission',
  message:
    'Kimi is running under the explicit unattested-development bypass; this is not credentialed live-canary evidence.'
}

describe('readProviderDiagnosticNotice', () => {
  it('reads the fields off the real Kimi runtime-admission payload', () => {
    expect(readProviderDiagnosticNotice(KIMI_ADMISSION)).toEqual({
      provider: 'kimi',
      source: 'kimi-runtime-admission',
      message: KIMI_ADMISSION.message
    })
  })

  it('reads the Kimi compatibility-filter payload, extra fields and all', () => {
    const notice = readProviderDiagnosticNotice({
      type: 'provider_diagnostic',
      provider: 'kimi',
      source: 'kimi-compatibility-filter',
      message: '2 sentences redacted before Kimi saw the prompt.',
      matchCount: 2,
      triggers: ['a', 'b']
    })
    expect(notice?.source).toBe('kimi-compatibility-filter')
    expect(notice?.message).toBe('2 sentences redacted before Kimi saw the prompt.')
  })

  it('returns null for other compat payloads and for messageless diagnostics', () => {
    expect(readProviderDiagnosticNotice({ type: 'content', text: 'hi' })).toBeNull()
    expect(readProviderDiagnosticNotice({ type: 'tool_use', tool_name: 'Read' })).toBeNull()
    expect(readProviderDiagnosticNotice({ type: 'provider_diagnostic', source: 'x' })).toBeNull()
    expect(readProviderDiagnosticNotice({ type: 'provider_diagnostic', message: '   ' })).toBeNull()
    expect(readProviderDiagnosticNotice(null)).toBeNull()
    expect(readProviderDiagnosticNotice('provider_diagnostic')).toBeNull()
    expect(readProviderDiagnosticNotice([{ type: 'provider_diagnostic', message: 'x' }])).toBeNull()
  })
})

describe('formatProviderDiagnosticNotice', () => {
  it('brackets the scope so the source cannot read as a file path', () => {
    expect(formatProviderDiagnosticNotice(KIMI_ADMISSION)).toBe(
      `${PROVIDER_DIAGNOSTIC_LOG_PREFIX} [kimi/kimi-runtime-admission]: ${KIMI_ADMISSION.message}`
    )
  })

  it('keeps the message when scope fields are missing', () => {
    expect(formatProviderDiagnosticNotice({ message: 'bare' })).toBe(
      `${PROVIDER_DIAGNOSTIC_LOG_PREFIX}: bare`
    )
    expect(formatProviderDiagnosticNotice({ provider: 'pi', message: 'bare' })).toBe(
      `${PROVIDER_DIAGNOSTIC_LOG_PREFIX} [pi]: bare`
    )
  })

  it('never emits a dangling separator when there is no message', () => {
    expect(formatProviderDiagnosticNotice({ provider: 'kimi', source: 's' })).toBe(
      `${PROVIDER_DIAGNOSTIC_LOG_PREFIX} [kimi/s]`
    )
  })
})

describe('isProviderDiagnosticLogLine', () => {
  it('recognises what the formatter writes, including a leading-space raw log line', () => {
    expect(isProviderDiagnosticLogLine(formatProviderDiagnosticNotice(KIMI_ADMISSION))).toBe(true)
    expect(isProviderDiagnosticLogLine(`  ${formatProviderDiagnosticNotice(KIMI_ADMISSION)}`)).toBe(
      true
    )
  })

  it('rejects ordinary provider output', () => {
    expect(isProviderDiagnosticLogLine('Provider output: content')).toBe(false)
    expect(isProviderDiagnosticLogLine('')).toBe(false)
    expect(isProviderDiagnosticLogLine(undefined)).toBe(false)
  })
})
