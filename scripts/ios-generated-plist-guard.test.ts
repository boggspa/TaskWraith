import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { evaluatePlistDrift, plistStringList, specStringList } =
  require('./ios-generated-plist-guard.cjs') as {
    evaluatePlistDrift: (spec: string, plist: string, keys?: string[]) => string[]
    plistStringList: (source: string, key: string) => string[] | null
    specStringList: (source: string, key: string) => string[] | null
  }

const SPEC = [
  'targets:',
  '  TaskWraith:',
  '    info:',
  '      path: Generated/Info.plist',
  '      properties:',
  '        # iPhone stays portrait-first; iPad rotates freely.',
  '        UISupportedInterfaceOrientations:',
  '          - UIInterfaceOrientationPortrait',
  '        UISupportedInterfaceOrientations~ipad:',
  '          - UIInterfaceOrientationPortrait',
  '          - UIInterfaceOrientationLandscapeLeft',
  '        NSCameraUsageDescription: "Scan the pairing QR code."'
].join('\n')

const plistFixture = (iphone: string[], ipad: string[]): string =>
  [
    '<plist version="1.0">',
    '<dict>',
    '\t<key>UISupportedInterfaceOrientations</key>',
    '\t<array>',
    ...iphone.map((o) => `\t\t<string>${o}</string>`),
    '\t</array>',
    '\t<key>UISupportedInterfaceOrientations~ipad</key>',
    '\t<array>',
    ...ipad.map((o) => `\t\t<string>${o}</string>`),
    '\t</array>',
    '</dict>',
    '</plist>'
  ].join('\n')

const PORTRAIT = ['UIInterfaceOrientationPortrait']
const IPAD = ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft']

describe('specStringList', () => {
  it('reads a flat list under its key', () => {
    expect(specStringList(SPEC, 'UISupportedInterfaceOrientations')).toEqual(PORTRAIT)
    expect(specStringList(SPEC, 'UISupportedInterfaceOrientations~ipad')).toEqual(IPAD)
  })

  it('stops at the next sibling key instead of swallowing the rest of the file', () => {
    // The iPhone key is immediately followed by the iPad key, whose items are
    // at the SAME indent as the iPhone key's. A parser that just scanned
    // forward for `- ` lines would report four iPhone orientations and the
    // guard would then pass while portrait-only was broken.
    expect(specStringList(SPEC, 'UISupportedInterfaceOrientations')).toHaveLength(1)
  })

  it('skips comments and returns null for absent or non-list keys', () => {
    expect(specStringList(SPEC, 'NSCameraUsageDescription')).toBeNull()
    expect(specStringList(SPEC, 'UINotAKey')).toBeNull()
  })
})

describe('plistStringList', () => {
  it('reads the array following a key', () => {
    expect(
      plistStringList(plistFixture(PORTRAIT, IPAD), 'UISupportedInterfaceOrientations')
    ).toEqual(PORTRAIT)
  })

  it('does not let the ~ipad suffix match the bare key', () => {
    // `~` and the regex-escaping around it matter: a loose pattern matches the
    // iPhone key's array when asked for the iPad one.
    const plist = plistFixture(PORTRAIT, IPAD)
    expect(plistStringList(plist, 'UISupportedInterfaceOrientations~ipad')).toEqual(IPAD)
  })

  it('returns null when the key is absent', () => {
    expect(
      plistStringList('<plist><dict></dict></plist>', 'UISupportedInterfaceOrientations')
    ).toBe(null)
  })
})

describe('evaluatePlistDrift', () => {
  it('passes when the plist matches the spec', () => {
    expect(evaluatePlistDrift(SPEC, plistFixture(PORTRAIT, IPAD))).toEqual([])
  })

  it('catches the real regression: Xcode re-adding landscape to the iPhone', () => {
    const drifted = plistFixture(
      [...PORTRAIT, 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
      IPAD
    )
    const failures = evaluatePlistDrift(SPEC, drifted)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('UISupportedInterfaceOrientations:')
    expect(failures[0]).toContain('LandscapeLeft')
  })

  it('catches a REORDERED array — the first entry is the preferred orientation', () => {
    const reordered = plistFixture(PORTRAIT, [...IPAD].reverse())
    expect(evaluatePlistDrift(SPEC, reordered)).toHaveLength(1)
  })

  it('reports a missing key rather than passing it over', () => {
    const failures = evaluatePlistDrift(SPEC, '<plist><dict></dict></plist>')
    expect(failures).toHaveLength(2)
    expect(failures.every((f) => f.includes('absent from Generated/Info.plist'))).toBe(true)
  })
})

describe('the real repo files', () => {
  it('keeps the shipped plist in step with the shipped spec', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = process.cwd()
    const spec = readFileSync(join(root, 'ios/TaskWraithApp/project.yml'), 'utf8')
    const plist = readFileSync(join(root, 'ios/TaskWraithApp/Generated/Info.plist'), 'utf8')
    expect(evaluatePlistDrift(spec, plist)).toEqual([])
  })

  it('keeps portrait as the iPhone target’s PREFERRED orientation', () => {
    // Pin the DECISION, not just the agreement between the two files. The
    // decision changed in ba93d11ec — the iPhone now rotates — so this no
    // longer pins portrait-only. What survives is the ordering: iOS treats the
    // first entry as preferred, so a reordering that demoted portrait would be
    // a real behaviour change and should have to edit this test to land.
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const spec = readFileSync(join(process.cwd(), 'ios/TaskWraithApp/project.yml'), 'utf8')
    const iphone = specStringList(spec, 'UISupportedInterfaceOrientations')
    expect(iphone?.[0]).toBe('UIInterfaceOrientationPortrait')
    expect(iphone).not.toContain('UIInterfaceOrientationPortraitUpsideDown')
  })
})
