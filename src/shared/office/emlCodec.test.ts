import { describe, expect, it } from 'vitest'
import {
  buildEml,
  decodeEncodedWords,
  decodeQuotedPrintable,
  encodeQuotedPrintable,
  parseEml
} from './emlCodec'
import type { MailDocumentModel } from './officeModels'

describe('parseEml', () => {
  it('parses a simple plain-text message with folded headers', () => {
    const raw = [
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>,',
      ' Carol <carol@example.com>',
      'Subject: Weekly update',
      'Date: Fri, 25 Jul 2026 09:00:00 +0100',
      'X-Priority: 1',
      '',
      'Hello team,',
      '',
      'All good.'
    ].join('\r\n')
    const { model, warnings } = parseEml(raw)
    expect(warnings).toEqual([])
    expect(model.from).toBe('Alice <alice@example.com>')
    expect(model.to).toBe('Bob <bob@example.com>, Carol <carol@example.com>')
    expect(model.subject).toBe('Weekly update')
    expect(model.date).toBe('Fri, 25 Jul 2026 09:00:00 +0100')
    expect(model.body).toBe('Hello team,\n\nAll good.')
    expect(model.extraHeaders).toEqual([{ name: 'X-Priority', value: '1' }])
  })

  it('picks the text/plain part of a multipart/alternative message', () => {
    const raw = [
      'From: a@b.c',
      'To: d@e.f',
      'Subject: Multi',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="XYZ"',
      '',
      '--XYZ',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 plans =E2=80=94 tonight',
      '--XYZ',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Caf&eacute; plans</p>',
      '--XYZ--',
      ''
    ].join('\r\n')
    const { model } = parseEml(raw)
    expect(model.body).toBe('Café plans — tonight')
  })

  it('falls back to de-tagged HTML when no plain part exists', () => {
    const raw = [
      'From: a@b.c',
      'Subject: HtmlOnly',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><h1>Title</h1><p>First</p><p>Second &amp; last</p></body></html>'
    ].join('\r\n')
    const { model, warnings } = parseEml(raw)
    expect(model.body).toBe('Title\nFirst\nSecond & last')
    expect(warnings.some((warning) => warning.includes('HTML'))).toBe(true)
  })

  it('decodes base64 bodies and RFC 2047 subjects', () => {
    const bodyBase64 = Buffer.from('Ünïcode body ✓', 'utf8').toString('base64')
    const raw = [
      'From: a@b.c',
      'Subject: =?utf-8?B?' + Buffer.from('Résumé ✓', 'utf8').toString('base64') + '?=',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyBase64
    ].join('\r\n')
    const { model } = parseEml(raw)
    expect(model.subject).toBe('Résumé ✓')
    expect(model.body).toBe('Ünïcode body ✓')
  })
})

describe('encoded words', () => {
  it('decodes Q-encoding with underscores and hex escapes', () => {
    expect(decodeEncodedWords('=?utf-8?Q?Caf=C3=A9_time?=')).toBe('Café time')
  })

  it('joins adjacent encoded words without intervening space', () => {
    const value =
      '=?utf-8?B?' +
      Buffer.from('ab', 'utf8').toString('base64') +
      '?= =?utf-8?B?' +
      Buffer.from('cd', 'utf8').toString('base64') +
      '?='
    expect(decodeEncodedWords(value)).toBe('abcd')
  })
})

describe('quoted-printable', () => {
  it('round-trips unicode text through encode/decode', () => {
    const text = 'Line one — dash\nLine two: café ünïcode ✓\nTrailing space '
    expect(decodeQuotedPrintable(encodeQuotedPrintable(text))).toBe(text.replace(/\n/g, '\r\n'))
  })

  it('keeps encoded lines within 76 characters', () => {
    const encoded = encodeQuotedPrintable('é'.repeat(300))
    for (const line of encoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76)
    }
  })
})

describe('buildEml', () => {
  it('produces a message that parses back to the same model', () => {
    const model: MailDocumentModel = {
      kind: 'mail',
      from: 'Alice <alice@example.com>',
      to: 'bob@example.com',
      cc: '',
      bcc: '',
      subject: 'Résumé — final ✓',
      body: 'Hello Bob,\n\nHere is the café plan.\n',
      extraHeaders: [{ name: 'X-Priority', value: '1' }]
    }
    const raw = buildEml(model, { date: 'Fri, 25 Jul 2026 09:00:00 +0000' })
    expect(raw).toContain('Content-Transfer-Encoding: quoted-printable')
    const { model: reparsed } = parseEml(raw)
    expect(reparsed.from).toBe(model.from)
    expect(reparsed.subject).toBe(model.subject)
    expect(reparsed.body).toBe('Hello Bob,\n\nHere is the café plan.')
    expect(reparsed.extraHeaders).toEqual(model.extraHeaders)
    expect(reparsed.date).toBe('Fri, 25 Jul 2026 09:00:00 +0000')
  })

  it('omits empty recipient headers', () => {
    const raw = buildEml(
      { kind: 'mail', from: 'a@b.c', to: 'd@e.f', cc: '', bcc: '', subject: 'S', body: 'B' },
      { date: 'Fri, 25 Jul 2026 09:00:00 +0000' }
    )
    expect(raw).not.toContain('Cc:')
    expect(raw).not.toContain('Bcc:')
  })
})
