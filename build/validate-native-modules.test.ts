import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

interface BundleIdentity {
  bundleIdentifier: string
  shortVersion: string
  bundleVersion: string
}

const {
  alignMacBridgeHelperIdentity,
  bundleIdentityFromInfo,
  readMacBundleIdentity,
  readPlistAsJson,
  resolveMacBridgeInfoPath,
  validateMacBridgeInfo
} = require('./validate-native-modules.cjs') as {
  alignMacBridgeHelperIdentity: (
    resourcesDir: string,
    expected: BundleIdentity
  ) => { infoPath: string; changed: boolean; rewritten: string[]; identity: BundleIdentity }
  bundleIdentityFromInfo: (info: Record<string, unknown>, infoPath: string) => BundleIdentity
  readMacBundleIdentity: (resourcesDir: string, context: Record<string, unknown>) => BundleIdentity
  readPlistAsJson: (plistPath: string, label: string) => Record<string, unknown>
  resolveMacBridgeInfoPath: (resourcesDir: string) => string
  validateMacBridgeInfo: (
    info: Record<string, unknown>,
    infoPath: string,
    expected?: BundleIdentity
  ) => void
}

const IDENTITY_KEYS = ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion']

const BETA: BundleIdentity = {
  bundleIdentifier: 'com.chrisizatt.taskwraith',
  shortVersion: '1.9.8',
  bundleVersion: '1.9.8'
}

const DEBUT: BundleIdentity = {
  bundleIdentifier: 'com.taskwraith.desktop',
  shortVersion: '0.1.0',
  bundleVersion: '0.1.0.42'
}

// Every helper key that is NOT part of the copied identity. The alignment must
// leave all of these exactly as build-bridge-daemon.cjs wrote them.
const BRIDGE_FIELDS = {
  CFBundleExecutable: 'TaskWraithBridgeDaemon',
  CFBundleName: 'TaskWraith',
  CFBundleDisplayName: 'TaskWraith',
  NSSpeechRecognitionUsageDescription: 'Transcribes media selected by the user.'
}

function infoFor(
  identity: BundleIdentity,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    CFBundleIdentifier: identity.bundleIdentifier,
    CFBundleShortVersionString: identity.shortVersion,
    CFBundleVersion: identity.bundleVersion,
    ...extra
  }
}

function plist(values: Record<string, string>): string {
  const fields = Object.entries(values)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${fields}
</dict>
</plist>
`
}

describe('macOS bridge helper identity', () => {
  it('reads the parent bundle identity and rejects an incomplete Info.plist', () => {
    expect(bundleIdentityFromInfo(infoFor(DEBUT), '/tmp/Info.plist')).toEqual(DEBUT)
    for (const key of IDENTITY_KEYS) {
      const missing = infoFor(DEBUT)
      delete missing[key]
      expect(() => bundleIdentityFromInfo(missing, '/tmp/Info.plist')).toThrow(new RegExp(key))
      expect(() =>
        bundleIdentityFromInfo({ ...infoFor(DEBUT), [key]: ' ' }, '/tmp/Info.plist')
      ).toThrow(new RegExp(key))
    }
  })

  it.each([
    ['beta', BETA],
    ['debut', DEBUT]
  ])('accepts a bridge helper that mirrors the %s parent identity', (_label, identity) => {
    expect(() =>
      validateMacBridgeInfo(infoFor(identity, BRIDGE_FIELDS), '/tmp/Info.plist', identity)
    ).not.toThrow()
  })

  it('refuses to validate without the parent identity, even for the beta literal', () => {
    expect(() => validateMacBridgeInfo(infoFor(BETA, BRIDGE_FIELDS), '/tmp/Info.plist')).toThrow(
      /parent app bundle identity/
    )
  })

  it('rejects a bridge helper whose identifier or versions drift from the parent', () => {
    expect(() =>
      validateMacBridgeInfo(infoFor(BETA, BRIDGE_FIELDS), '/tmp/Info.plist', DEBUT)
    ).toThrow(/CFBundleIdentifier com\.taskwraith\.desktop, got com\.chrisizatt\.taskwraith/)
    expect(() =>
      validateMacBridgeInfo(
        { ...infoFor(DEBUT, BRIDGE_FIELDS), CFBundleShortVersionString: '0.0.9' },
        '/tmp/Info.plist',
        DEBUT
      )
    ).toThrow(/CFBundleShortVersionString 0\.1\.0, got 0\.0\.9/)
    expect(() =>
      validateMacBridgeInfo(
        { ...infoFor(DEBUT, BRIDGE_FIELDS), CFBundleVersion: '0.1.0' },
        '/tmp/Info.plist',
        DEBUT
      )
    ).toThrow(/CFBundleVersion 0\.1\.0\.42, got 0\.1\.0/)
    expect(() =>
      validateMacBridgeInfo(
        { ...infoFor(DEBUT, BRIDGE_FIELDS), CFBundleExecutable: 'Other' },
        '/tmp/Info.plist',
        DEBUT
      )
    ).toThrow(/CFBundleExecutable/)
  })

  it.each([
    ['beta', BETA, []],
    ['debut', DEBUT, IDENTITY_KEYS]
  ])(
    'copies the %s parent identity into the packaged helper idempotently',
    (_label, identity, expectedRewrites) => {
      // plutil-backed; the plist rewrite is macOS-only by construction.
      if (process.platform !== 'darwin') return
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-bridge-identity-'))
      try {
        const contents = path.join(root, 'TaskWraith.app', 'Contents')
        const resources = path.join(contents, 'Resources')
        const bridgeInfoPath = resolveMacBridgeInfoPath(resources)
        fs.mkdirSync(resources, { recursive: true })
        fs.mkdirSync(path.dirname(bridgeInfoPath), { recursive: true })
        fs.writeFileSync(
          path.join(contents, 'Info.plist'),
          plist(infoFor(identity, { CFBundleName: 'TaskWraith' }))
        )
        // The helper always ships with the pre-pack beta default from
        // build-bridge-daemon.cjs, whatever identity the parent was packed with.
        fs.writeFileSync(bridgeInfoPath, plist(infoFor(BETA, BRIDGE_FIELDS)))

        const parent = readMacBundleIdentity(resources, {
          packager: { appInfo: { id: identity.bundleIdentifier } }
        })
        expect(parent).toEqual(identity)

        const first = alignMacBridgeHelperIdentity(resources, parent)
        expect(first.rewritten).toEqual(expectedRewrites)
        expect(first.changed).toBe(expectedRewrites.length > 0)
        expect(first.identity).toEqual(identity)

        const second = alignMacBridgeHelperIdentity(resources, parent)
        expect(second.changed).toBe(false)
        expect(second.rewritten).toEqual([])

        const written = readPlistAsJson(bridgeInfoPath, 'bridge Info.plist')
        expect(written).toEqual(infoFor(identity, BRIDGE_FIELDS))
        expect(() => validateMacBridgeInfo(written, bridgeInfoPath, parent)).not.toThrow()

        // The parent plist is the authority; a packager appId that disagrees
        // with it is a build error, not something to paper over.
        expect(() =>
          readMacBundleIdentity(resources, { packager: { appInfo: { id: 'com.example.other' } } })
        ).toThrow(/resolved appId com\.example\.other/)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
