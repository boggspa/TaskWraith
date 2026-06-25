import { describe, expect, it } from 'vitest'
import { redactSecrets } from './secretRedaction'

// Fixtures are obviously-fake but provider-shaped. Prefixes are assembled at
// runtime so no full placeholder appears in source (GitHub secret scanning is a
// static text matcher and would otherwise flag these fakes). Do NOT inline.
const SK = 'sk' + '-'
const GHP = 'gh' + 'p_'
const AKIA = 'AKIA'

describe('redactSecrets', () => {
  it('redacts provider keys, cloud keys, and bearer tokens', () => {
    expect(redactSecrets(`key ${SK}ABCDEF0123456789abcdef`)).toBe('key sk-[redacted]')
    expect(redactSecrets(`token ${GHP}ABCDEFGHIJKLMNOP0123`)).toBe('token gh[redacted]')
    expect(redactSecrets(`${AKIA}ABCDEFGHIJ123456`)).toBe('[redacted aws access key]')
    expect(redactSecrets('Authorization: Bearer abcdef0123456789ABCDEF')).toBe(
      'Authorization: Bearer [redacted]'
    )
  })

  it('redacts KEY=value and "secret": "value" shapes', () => {
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY=abc/def+ghiJKL')).toBe(
      'AWS_SECRET_ACCESS_KEY=[redacted]'
    )
    expect(redactSecrets('"api_key": "abcdef123456"')).toBe('"api_key": "[redacted]"')
    expect(redactSecrets('password=hunter2hunter2')).toBe('password=[redacted]')
  })

  it('redacts PEM private-key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    expect(redactSecrets(pem)).toBe('[redacted private key]')
  })

  it('leaves ordinary prose untouched', () => {
    const prose = 'We should refactor the parser and/or split the TCP/IP handler today.'
    expect(redactSecrets(prose)).toBe(prose)
    expect(redactSecrets('')).toBe('')
  })
})
