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

describe('shapes the loadOlder disclosure review found passing through verbatim', () => {
  // Each was verified leaking in a collaborator-visible preview before this.
  it('redacts a Google API key', () => {
    const out = redactSecrets('key is AIzaSyA1234567890abcdefghijklmnopqrstuv here')
    expect(out).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuv')
    expect(out).toContain('[redacted google api key]')
  })

  it('redacts a BARE npm token, with no key name to key off', () => {
    // Deliberately unlabelled. Written as `_authToken=npm_…` it was ALREADY
    // caught by the KEY=value rule (the key name contains TOKEN), so a test in
    // that shape passes with the vendor pattern removed and proves nothing —
    // which is exactly what a mutation run showed. The real gap is a token
    // pasted on its own.
    const token = 'npm_abcdefghij0123456789ABCDEFGHIJ012345'
    const out = redactSecrets(`here it is ${token} use it`)
    expect(out).not.toContain(token)
  })

  it('redacts a BARE jwt, not just one behind Bearer or a token: label', () => {
    // Same trap: `token: eyJ…` was already caught by the label rule. Unlabelled
    // is the shape that leaked.
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const out = redactSecrets(`paste this ${jwt} into the header`)
    expect(out).not.toContain('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')
  })

  it('redacts inline credentials in a connection string, keeping the host', () => {
    const out = redactSecrets('postgres://admin:hunter2@db.internal:5432/prod')
    expect(out).not.toContain('hunter2')
    // The line must stay diagnosable — scheme and host survive.
    expect(out).toContain('postgres://')
    expect(out).toContain('db.internal')
  })

  it('still does not mangle ordinary prose or plain URLs', () => {
    const prose =
      'See https://example.com/docs and the AIza prefix is documented there; eyJ is base64 for {"'
    expect(redactSecrets(prose)).toBe(prose)
  })
})
