import { describe, expect, it } from 'vitest'
import {
  attrByLocalName,
  childByLocalName,
  childrenByLocalName,
  deepText,
  descendantsByLocalName,
  escapeXmlAttr,
  escapeXmlText,
  firstDescendantByLocalName,
  localName,
  parseMarkup,
  sanitizeXmlText
} from './xmlLite'

describe('parseMarkup (xml mode)', () => {
  it('parses namespaced OOXML with attributes and nested elements', () => {
    const root = parseMarkup(
      '<?xml version="1.0"?><w:document xmlns:w="ns"><w:body><w:p><w:r><w:t xml:space="preserve">Hello &amp; bye</w:t></w:r></w:p></w:body></w:document>'
    )
    const doc = childByLocalName(root, 'document')
    expect(doc?.tag).toBe('w:document')
    const text = firstDescendantByLocalName(root, 't')
    expect(text?.text).toBe('Hello & bye')
    expect(attrByLocalName(text!, 'space')).toBe('preserve')
  })

  it('handles self-closing tags, comments, CDATA and DOCTYPE without entity expansion', () => {
    const root = parseMarkup(
      '<!DOCTYPE foo [<!ENTITY xxe "boom">]><a><!-- hi --><b val="1"/><![CDATA[<raw> &amp; text]]>&xxe;</a>'
    )
    const a = childByLocalName(root, 'a')!
    expect(childrenByLocalName(a, 'b')).toHaveLength(1)
    // CDATA stays raw; the undefined custom entity is left verbatim (no XXE).
    expect(a.text).toBe('<raw> &amp; text&xxe;')
  })

  it('recovers from mismatched close tags leniently', () => {
    const root = parseMarkup('<a><b>x</c></b><d>y</d></a>')
    const a = childByLocalName(root, 'a')!
    expect(childrenByLocalName(a, 'd')[0]?.text).toBe('y')
  })

  it('decodes numeric and named entities in text and attributes', () => {
    const root = parseMarkup('<a title="&quot;q&#x21;">&#65;&lt;&gt;</a>')
    const a = childByLocalName(root, 'a')!
    expect(a.text).toBe('A<>')
    expect(a.attrs.title).toBe('"q!')
  })
})

describe('parseMarkup (html mode)', () => {
  it('treats void elements as childless and lowercases tags', () => {
    const root = parseMarkup('<DIV>line1<BR>line2<IMG src="x">tail</DIV>', { html: true })
    const div = childByLocalName(root, 'div')!
    expect(childrenByLocalName(div, 'br')).toHaveLength(1)
    expect(childrenByLocalName(div, 'img')).toHaveLength(1)
    expect(div.text).toBe('line1line2tail')
  })

  it('keeps ordered #text children interleaved with elements', () => {
    const root = parseMarkup('<p>Hello <b>world</b> again</p>', { html: true })
    const p = childByLocalName(root, 'p')!
    expect(p.children.map((child) => child.tag)).toEqual(['#text', 'b', '#text'])
    expect(p.children[0].text).toBe('Hello ')
    expect(p.children[2].text).toBe(' again')
  })

  it('decodes &nbsp; and typographic entities', () => {
    const root = parseMarkup('<p>a&nbsp;b&mdash;c</p>', { html: true })
    expect(childByLocalName(root, 'p')!.text).toBe('a b—c')
  })
})

describe('helpers', () => {
  it('localName strips prefixes', () => {
    expect(localName('w:p')).toBe('p')
    expect(localName('p')).toBe('p')
  })

  it('deepText concatenates without double-counting #text children', () => {
    const root = parseMarkup('<a>x<b>y</b>z</a>')
    expect(deepText(childByLocalName(root, 'a')!)).toBe('xzy')
  })

  it('descendantsByLocalName finds nested matches depth-first', () => {
    const root = parseMarkup('<a><b><c/></b><c/></a>')
    expect(descendantsByLocalName(root, 'c')).toHaveLength(2)
  })

  it('escapes text and attributes safely', () => {
    expect(escapeXmlText('a<b>&c')).toBe('a&lt;b&gt;&amp;c')
    expect(escapeXmlAttr('"quoted" & <tag>')).toBe('&quot;quoted&quot; &amp; &lt;tag&gt;')
    expect(sanitizeXmlText('ok\u0000bad\tkeep\n')).toBe('okbad\tkeep\n')
  })
})
