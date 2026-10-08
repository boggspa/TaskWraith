import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

interface MacSigningIdentity {
  readable: boolean
  adhoc: boolean
  authorities: string[]
  leafAuthority: string | null
  teamIdentifier: string | null
  hardenedRuntime: boolean
  claimsProductionIdentity: boolean
}

const {
  evaluateMacSigningIdentity,
  collectMacSigningPostureFailures,
  collectMacBridgeIdentityFailures,
  describeMacSigningPosture,
  readMacSigningIdentity,
  readPackagedDistributionMetadata,
  resolvePackagedStudioPath,
  validatePackagedIdentityHandoffPayload
}: {
  evaluateMacSigningIdentity: (output: string, exitCode: number | null) => MacSigningIdentity
  collectMacSigningPostureFailures: (options: {
    identity: MacSigningIdentity
    label: string
    requireProduction?: boolean
  }) => string[]
  collectMacBridgeIdentityFailures: (
    bridgeInfo: Record<string, unknown>,
    parentInfo: Record<string, unknown>
  ) => string[]
  describeMacSigningPosture: (identity: MacSigningIdentity) => string
  readMacSigningIdentity: (codePath: string) => MacSigningIdentity
  readPackagedDistributionMetadata: (
    appAsarPath: string,
    asarApi: { extractFile: (asarPath: string, filePath: string) => Buffer }
  ) => {
    series: string
    appId: string
    stableUpdateChannel: string
    version: string
    studioIncluded: boolean
  }
  resolvePackagedStudioPath: (resourcesDir: string, included: boolean) => string | null
  validatePackagedIdentityHandoffPayload: (
    resourcesDir: string,
    metadata: { series: string; version: string }
  ) => void
} = require('./smoke-packaged-electron.cjs')

const {
  normalizeMacElectronHelperBundles,
  resolveMacBridgeDaemonPath,
  resolveMacBridgeInfoPath,
  validateMacBridgeInfo
} = require('../build/validate-native-modules.cjs') as {
  normalizeMacElectronHelperBundles: (
    resourcesPath: string,
    context: Record<string, any>
  ) => {
    permissionName: string
    productFilename: string
    helpers: Array<{ sourceName: string; targetName: string; changed: boolean }>
  }
  resolveMacBridgeDaemonPath: (resourcesPath: string) => string
  resolveMacBridgeInfoPath: (resourcesPath: string) => string
  validateMacBridgeInfo: (
    info: Record<string, unknown>,
    infoPath: string,
    expected?: { bundleIdentifier: string; shortVersion: string; bundleVersion: string }
  ) => void
}

// Verbatim shape of `codesign -dv --verbose=4` against an ad-hoc signed bundle,
// i.e. what a plain local `--dir` build produces with no signing identity. The
// Authority/TeamIdentifier lines that a real identity emits are simply absent,
// and codesign prints the literal string "not set" rather than omitting the key.
const ADHOC_OUTPUT = [
  'Executable=/tmp/dist/mac-universal/TaskWraith.app/Contents/MacOS/TaskWraith',
  'Identifier=com.taskwraith.app',
  'Format=app bundle with Mach-O universal (x86_64 arm64)',
  'CodeDirectory v=20400 size=1287 flags=0x2(adhoc) hashes=30+7 location=embedded',
  'Signature=adhoc',
  'Info.plist entries=40',
  'TeamIdentifier=not set',
  'Sealed Resources version=2 rules=13 files=214'
].join('\n')

// Verbatim shape of a Developer ID signed, hardened-runtime bundle. The three
// Authority lines and the `flags=0x10000(runtime)` marker match the banked
// capture in src/main/antigravity/AntigravityBinaryProvenance.test.ts.
const DEVELOPER_ID_OUTPUT = [
  'Executable=/tmp/dist/mac-universal/TaskWraith.app/Contents/MacOS/TaskWraith',
  'Identifier=com.taskwraith.app',
  'Format=app bundle with Mach-O universal (x86_64 arm64)',
  'CodeDirectory v=20500 size=1287 flags=0x10000(runtime) hashes=30+7 location=embedded',
  'Signature size=9051',
  'Authority=Developer ID Application: Example Owner (ABCDE12345)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=14 Aug 2026 at 16:00:00',
  'Info.plist entries=40',
  'TeamIdentifier=ABCDE12345',
  'Sealed Resources version=2 rules=13 files=214'
].join('\n')

describe('packaged Electron to TUI smoke handoff', () => {
  it('normalizes debug helper bundles to the signed permission identity before signing', () => {
    if (process.platform !== 'darwin') return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-helper-normalization-'))
    try {
      const appRoot = path.join(root, 'TaskWraith Debug.app')
      const contents = path.join(appRoot, 'Contents')
      const resources = path.join(contents, 'Resources')
      const frameworks = path.join(contents, 'Frameworks')
      fs.mkdirSync(resources, { recursive: true })
      fs.mkdirSync(frameworks, { recursive: true })
      fs.writeFileSync(path.join(contents, 'Info.plist'), plist({ CFBundleName: 'TaskWraith' }))

      const suffixes = ['', ' (GPU)', ' (Plugin)', ' (Renderer)']
      for (const suffix of suffixes) {
        const sourceName = `TaskWraith Debug Helper${suffix}`
        const helperContents = path.join(frameworks, `${sourceName}.app`, 'Contents')
        const macos = path.join(helperContents, 'MacOS')
        fs.mkdirSync(macos, { recursive: true })
        fs.writeFileSync(path.join(macos, sourceName), sourceName)
        fs.writeFileSync(
          path.join(helperContents, 'Info.plist'),
          plist({
            CFBundleDisplayName: sourceName,
            CFBundleExecutable: sourceName,
            CFBundleIdentifier: `com.example.helper${suffix.replace(/\W/g, '')}`
          })
        )
      }

      const context = {
        packager: { appInfo: { productFilename: 'TaskWraith Debug' } }
      }
      const first = normalizeMacElectronHelperBundles(resources, context)
      expect(first).toMatchObject({
        permissionName: 'TaskWraith',
        productFilename: 'TaskWraith Debug'
      })
      expect(first.helpers.every((entry) => entry.changed)).toBe(true)

      for (const suffix of suffixes) {
        const sourceName = `TaskWraith Debug Helper${suffix}`
        const targetName = `TaskWraith Helper${suffix}`
        const sourceApp = path.join(frameworks, `${sourceName}.app`)
        const targetApp = path.join(frameworks, `${targetName}.app`)
        expect(fs.existsSync(sourceApp)).toBe(false)
        expect(fs.existsSync(path.join(targetApp, 'Contents', 'MacOS', targetName))).toBe(true)
        const info = fs.readFileSync(path.join(targetApp, 'Contents', 'Info.plist'), 'utf8')
        expect(info).toContain(`<string>${targetName}</string>`)
        expect(info).not.toContain(`<string>${sourceName}</string>`)
      }

      const second = normalizeMacElectronHelperBundles(resources, context)
      expect(second.helpers.every((entry) => entry.changed === false)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('validates the native daemon from the macOS helper location', () => {
    expect(resolveMacBridgeDaemonPath('/Applications/TaskWraith.app/Contents/Resources')).toBe(
      '/Applications/TaskWraith.app/Contents/Helpers/TaskWraith Bridge.app/Contents/MacOS/TaskWraithBridgeDaemon'
    )
    expect(resolveMacBridgeInfoPath('/Applications/TaskWraith.app/Contents/Resources')).toBe(
      '/Applications/TaskWraith.app/Contents/Helpers/TaskWraith Bridge.app/Contents/Info.plist'
    )
  })

  it('requires the helper consent identity and Speech usage metadata after packing', () => {
    const parent = {
      bundleIdentifier: 'com.chrisizatt.taskwraith',
      shortVersion: '1.9.8',
      bundleVersion: '1.9.8'
    }
    const valid = {
      CFBundleIdentifier: 'com.chrisizatt.taskwraith',
      CFBundleShortVersionString: '1.9.8',
      CFBundleVersion: '1.9.8',
      CFBundleExecutable: 'TaskWraithBridgeDaemon',
      NSSpeechRecognitionUsageDescription: 'Transcribes media selected by the user.'
    }
    expect(() => validateMacBridgeInfo(valid, '/tmp/Info.plist', parent)).not.toThrow()
    // No literal fallback: even the beta identity is rejected without the parent.
    expect(() => validateMacBridgeInfo(valid, '/tmp/Info.plist')).toThrow(
      /parent app bundle identity/
    )
    expect(() =>
      validateMacBridgeInfo(
        { ...valid, NSSpeechRecognitionUsageDescription: ' ' },
        '/tmp/Info.plist',
        parent
      )
    ).toThrow(/NSSpeechRecognitionUsageDescription/)
  })

  it('verifies the bridge helper against the packaged app identity for beta and debut', () => {
    for (const [appId, version] of [
      ['com.chrisizatt.taskwraith', '1.9.8'],
      ['com.taskwraith.desktop', '0.1.0']
    ]) {
      const parentInfo = {
        CFBundleIdentifier: appId,
        CFBundleShortVersionString: version,
        CFBundleVersion: version
      }
      const bridgeInfo = { ...parentInfo, CFBundleExecutable: 'TaskWraithBridgeDaemon' }
      expect(collectMacBridgeIdentityFailures(bridgeInfo, parentInfo)).toEqual([])
    }
    const debut = {
      CFBundleIdentifier: 'com.taskwraith.desktop',
      CFBundleShortVersionString: '0.1.0',
      CFBundleVersion: '0.1.0'
    }
    expect(
      collectMacBridgeIdentityFailures(
        { ...debut, CFBundleIdentifier: 'com.chrisizatt.taskwraith' },
        debut
      )
    ).toEqual([
      expect.stringMatching(
        /CFBundleIdentifier must match the packaged app CFBundleIdentifier com\.taskwraith\.desktop, got com\.chrisizatt\.taskwraith/
      )
    ])
    expect(
      collectMacBridgeIdentityFailures({ ...debut, CFBundleVersion: '0.1.0.1' }, debut)
    ).toEqual([expect.stringMatching(/CFBundleVersion must match .* 0\.1\.0, got 0\.1\.0\.1/)])
    expect(
      collectMacBridgeIdentityFailures(debut, { CFBundleIdentifier: 'com.taskwraith.desktop' })
    ).toEqual([
      expect.stringMatching(/missing a non-empty CFBundleShortVersionString/),
      expect.stringMatching(/missing a non-empty CFBundleVersion/)
    ])
  })

  it('keeps the real emulator runtime launch opt-in and passes the exact package root', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-electron.cjs'),
      'utf8'
    )

    expect(source).toContain('runPackagedEmulatorRuntimeSmoke(packageRoot)')
    expect(source).toContain("TASKWRAITH_RUN_EMULATOR_PACKAGE_SMOKE !== '1'")
    expect(source).toContain("path.join(repoRoot, 'scripts/smoke-packaged-emulator.cjs')")
    expect(source).toContain('spawnSync(process.execPath, [smokeScript, packageRoot]')
  })

  it('requires and runs the production Host smoke for every packaged artifact', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'smoke-packaged-electron.cjs'),
      'utf8'
    )

    expect(source).toContain('runPackagedProductionHostSmoke(packageRoot)')
    expect(source).toContain("path.join(resourcesDir, 'host')")
    expect(source).toContain("path.join(resourcesDir, 'host-bin')")
    expect(source).toContain('production Host resources are incomplete')
    expect(source).toContain("TASKWRAITH_HOST_REQUIRE_PACKAGE: '1'")
  })

  it('passes the exact package root instead of rediscovering an architecture sibling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-package-siblings-'))
    const x64 = path.join(root, 'win-unpacked')
    const arm64 = path.join(root, 'win-arm64-unpacked')
    fs.mkdirSync(path.join(x64, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(arm64, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(x64, 'resources', 'app.asar'), '')
    fs.writeFileSync(path.join(arm64, 'resources', 'app.asar'), '')

    try {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'scripts', 'smoke-packaged-electron.cjs'),
        'utf8'
      )
      expect(source).toContain('spawnSync(process.execPath, [smokeScript, packageRoot]')
      expect(source).not.toContain('const searchRoot = path.dirname(packageRoot)')
      expect(fs.existsSync(path.join(x64, 'resources', 'app.asar'))).toBe(true)
      expect(fs.existsSync(path.join(arm64, 'resources', 'app.asar'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // Requiring the script must not run the smoke itself. Without an entry-point
  // guard, importing it here would execute main() against the real repo and
  // exit the test process.
  it('exposes its signing helpers without executing the smoke run', () => {
    expect(typeof evaluateMacSigningIdentity).toBe('function')
    expect(typeof collectMacSigningPostureFailures).toBe('function')
  })

  it('accepts only coherent beta or Release identity metadata in app.asar', () => {
    const extract = (metadata: Record<string, unknown>) => ({
      extractFile: () => Buffer.from(JSON.stringify(metadata))
    })
    expect(
      readPackagedDistributionMetadata(
        '/tmp/app.asar',
        extract({
          taskwraithDistributionIdentity: 'beta',
          taskwraithAppId: 'com.chrisizatt.taskwraith',
          taskwraithUpdateFeedChannel: 'latest',
          version: '1.9.8'
        })
      )
    ).toEqual({
      series: 'beta',
      appId: 'com.chrisizatt.taskwraith',
      stableUpdateChannel: 'latest',
      version: '1.9.8',
      studioIncluded: true
    })
    expect(
      readPackagedDistributionMetadata(
        '/tmp/app.asar',
        extract({
          taskwraithDistributionIdentity: 'release',
          taskwraithAppId: 'com.taskwraith.desktop',
          taskwraithUpdateFeedChannel: 'release',
          taskwraithStudioCompanionIncluded: false,
          version: '0.1.0'
        })
      )
    ).toEqual({
      series: 'release',
      appId: 'com.taskwraith.desktop',
      stableUpdateChannel: 'release',
      version: '0.1.0',
      studioIncluded: false
    })
  })

  it('requires the payload only in 1.9.9 beta and excludes it from Release', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-package-handoff-'))
    try {
      expect(() =>
        validatePackagedIdentityHandoffPayload(root, { series: 'release', version: '0.1.0' })
      ).not.toThrow()
      expect(() =>
        validatePackagedIdentityHandoffPayload(root, { series: 'beta', version: '1.9.8' })
      ).not.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

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

describe('packaged macOS signing posture', () => {
  // The defect this suite exists for: `codesign --verify --strict` inspects
  // seal integrity only, so it exits 0 on an ad-hoc signature. Nothing in the
  // ad-hoc report carries an Authority or a real TeamIdentifier, which is why a
  // verify-only check can report success on a build that has no production
  // signing identity at all.
  it('classifies an ad-hoc signature as ad-hoc and refuses to call it production', () => {
    const identity = evaluateMacSigningIdentity(ADHOC_OUTPUT, 0)

    expect(identity.readable).toBe(true)
    expect(identity.adhoc).toBe(true)
    expect(identity.authorities).toEqual([])
    expect(identity.leafAuthority).toBeNull()
    expect(identity.hardenedRuntime).toBe(false)
    expect(identity.claimsProductionIdentity).toBe(false)

    const failures = collectMacSigningPostureFailures({
      identity,
      label: 'Packaged app',
      requireProduction: true
    })
    expect(failures.join('\n')).toMatch(/ad-hoc/i)
  })

  // codesign prints the literal "not set" for a bundle with no team. Treating
  // that string as a value yields "signed by team not set", and — worse — makes
  // a truthiness check on the parsed team identifier pass for an ad-hoc build.
  it('does not accept codesign’s literal "not set" as a team identifier', () => {
    const identity = evaluateMacSigningIdentity(ADHOC_OUTPUT, 0)
    expect(identity.teamIdentifier).toBeNull()
    expect(describeMacSigningPosture(identity)).not.toMatch(/not set/)
  })

  it('accepts a Developer ID signature with a hardened runtime', () => {
    const identity = evaluateMacSigningIdentity(DEVELOPER_ID_OUTPUT, 0)

    expect(identity.adhoc).toBe(false)
    expect(identity.leafAuthority).toBe('Developer ID Application: Example Owner (ABCDE12345)')
    expect(identity.authorities).toContain('Apple Root CA')
    expect(identity.teamIdentifier).toBe('ABCDE12345')
    expect(identity.hardenedRuntime).toBe(true)
    expect(identity.claimsProductionIdentity).toBe(true)

    expect(
      collectMacSigningPostureFailures({
        identity,
        label: 'Packaged app',
        requireProduction: true
      })
    ).toEqual([])
  })

  // A development certificate produces a full Authority chain and a real team
  // identifier, so every "is it signed / does it have a team" check passes. It
  // is still not distributable: only a Developer ID Application leaf is.
  it('rejects a development certificate even though it carries a real team', () => {
    const identity = evaluateMacSigningIdentity(
      DEVELOPER_ID_OUTPUT.replace(
        'Authority=Developer ID Application: Example Owner (ABCDE12345)',
        'Authority=Apple Development: owner@example.com (ABCDE12345)'
      ),
      0
    )

    expect(identity.adhoc).toBe(false)
    expect(identity.teamIdentifier).toBe('ABCDE12345')
    expect(identity.claimsProductionIdentity).toBe(true)

    const failures = collectMacSigningPostureFailures({ identity, label: 'Packaged app' })
    expect(failures.join('\n')).toMatch(/Developer ID Application/)
  })

  // Hardened runtime is a notarization precondition. Without this assertion a
  // correctly Developer-ID-signed build still fails notarization downstream,
  // and the smoke would have reported the signature as fully validated.
  it('rejects a Developer ID signature that is missing the hardened runtime', () => {
    const identity = evaluateMacSigningIdentity(
      DEVELOPER_ID_OUTPUT.replace('flags=0x10000(runtime) ', ''),
      0
    )

    expect(identity.leafAuthority).toMatch(/^Developer ID Application:/)
    expect(identity.hardenedRuntime).toBe(false)

    const failures = collectMacSigningPostureFailures({ identity, label: 'Packaged app' })
    expect(failures.join('\n')).toMatch(/hardened runtime/i)
  })

  // The team in the leaf authority and the standalone TeamIdentifier come from
  // different parts of the report. A mismatch means the parsed identity is not
  // describing one coherent signature.
  it('rejects a signature whose leaf authority team disagrees with TeamIdentifier', () => {
    const identity = evaluateMacSigningIdentity(
      DEVELOPER_ID_OUTPUT.replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=ZZZZZ99999'),
      0
    )

    const failures = collectMacSigningPostureFailures({ identity, label: 'Packaged app' })
    expect(failures.join('\n')).toMatch(/ABCDE12345/)
    expect(failures.join('\n')).toMatch(/ZZZZZ99999/)
  })

  // An unsigned bundle exits non-zero. That is a definite negative, not an
  // "unable to check", and must never be silently tolerated.
  it('treats an unreadable signature as a failure rather than an unknown', () => {
    const identity = evaluateMacSigningIdentity('code object is not signed at all', 1)

    expect(identity.readable).toBe(false)
    expect(identity.claimsProductionIdentity).toBe(false)
    expect(
      collectMacSigningPostureFailures({ identity, label: 'Packaged app' }).join('\n')
    ).toMatch(/signature/i)
  })

  // A local --dir build is legitimately ad-hoc. It must be reported honestly
  // rather than failing the developer loop, but it must not be described as a
  // validated production signature either.
  it('permits an ad-hoc build only when production posture is not required', () => {
    const identity = evaluateMacSigningIdentity(ADHOC_OUTPUT, 0)

    expect(collectMacSigningPostureFailures({ identity, label: 'Packaged app' })).toEqual([])
    expect(describeMacSigningPosture(identity)).toMatch(/ad-hoc/i)
    expect(describeMacSigningPosture(identity)).not.toMatch(/Developer ID/)
  })
})

describe('notarized macOS production-signing gate', () => {
  // The packaged smoke defaults to reporting an ad-hoc identity without failing
  // so local unsigned builds remain usable. The real notarized build must opt
  // into the hard production posture at the exact smoke invocation; otherwise
  // every parser assertion above is dormant in the release path.
  it('activates production signing checks for the notarized packaged smoke', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }
    const notarizedBuild = packageJson.scripts?.['build:mac:notarized'] ?? ''

    expect(notarizedBuild).toMatch(
      /(?:^|&&\s*)TASKWRAITH_REQUIRE_PRODUCTION_SIGNING=1 node scripts\/smoke-packaged-electron\.cjs dist(?:\s*&&|$)/
    )
  })
})

describe('production-signing gate covers every notarizing build', () => {
  const scripts =
    (
      JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
      }
    ).scripts ?? {}

  const notarizing = Object.entries(scripts).filter(([, body]) => /notarize=true/.test(body))

  // Guards the scan itself. If the flag is ever renamed, `notarizing` becomes
  // empty and the check below would pass while inspecting nothing — the same
  // vacuous-pass shape this suite exists to catch.
  it('finds the notarizing scripts it claims to be checking', () => {
    expect(notarizing.map(([name]) => name)).toEqual(
      expect.arrayContaining(['build:mac:notarized', 'build:debug:mac:notarized'])
    )
  })

  // Notarization requires a Developer ID signature and the hardened runtime, so
  // every script that notarizes must run the packaged smoke under the hard
  // production posture. Naming one script explicitly cannot see a second one.
  it('gates the packaged smoke in every script that notarizes', () => {
    const ungated: string[] = []
    for (const [name, body] of notarizing) {
      const calls = body.match(/(?:\S+=\S+\s+)*node scripts\/smoke-packaged-electron\.cjs \S+/g)
      for (const call of calls ?? []) {
        if (!/TASKWRAITH_REQUIRE_PRODUCTION_SIGNING=1/.test(call)) ungated.push(`${name}: ${call}`)
      }
    }
    expect(ungated).toEqual([])
  })
})

// The parser above is exercised with captured text. These drive the real spawn
// wrapper against a binary macOS is guaranteed to have signed, so a wrapper
// that never invoked the tool, or drifted from its actual output, fails here.
describe.skipIf(process.platform !== 'darwin')('real signature reads', () => {
  it('parses a genuinely signed system binary through the spawn wrapper', () => {
    const identity = readMacSigningIdentity('/bin/ls')

    expect(identity.readable).toBe(true)
    expect(identity.adhoc).toBe(false)
    expect(identity.leafAuthority).toBe('Software Signing')
    expect(identity.authorities).toContain('Apple Root CA')
    // The real report for a platform binary literally says
    // "TeamIdentifier=not set". Proving the guard against actual output is
    // worth more than proving it against a fixture I wrote myself.
    expect(identity.teamIdentifier).toBeNull()
  })

  // Apple's own platform signature satisfies "is it signed" and "does it chain
  // to Apple Root CA", which is exactly why those questions are insufficient:
  // it is still not a Developer ID distribution identity.
  it('refuses an Apple platform signature as a distribution identity', () => {
    const failures = collectMacSigningPostureFailures({
      identity: readMacSigningIdentity('/bin/ls'),
      label: 'Packaged app'
    })

    expect(failures.join('\n')).toMatch(/Developer ID Application/)
    expect(failures.join('\n')).toMatch(/Team Identifier/)
  })
})

describe('packaged macOS signature coverage', () => {
  it('rejects a leftover Studio bundle when the artifact declares it excluded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excluded-studio-'))
    try {
      expect(resolvePackagedStudioPath(root, false)).toBeNull()
      const bundle = path.join(root, 'studio', 'TaskWraith Studio.app')
      fs.mkdirSync(bundle, { recursive: true })
      expect(() => resolvePackagedStudioPath(root, false)).toThrow('Studio is excluded')
      expect(resolvePackagedStudioPath(root, true)).toBe(bundle)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'smoke-packaged-electron.cjs'),
    'utf8'
  )

  // The nested Studio bundle was verified without --deep while the outer app
  // used it, so a broken seal inside Studio.app could not be observed.
  it('verifies the nested Studio bundle as deeply as the outer app', () => {
    const studioVerify = source.match(
      /const studioVerification = spawnSync\(\s*'\/usr\/bin\/codesign',\s*\[([^\]]*)\]/
    )
    expect(studioVerify?.[1]).toBeTruthy()
    expect(studioVerify?.[1]).toContain("'--deep'")
  })

  // Studio.app was absent from requiredEntitlementsByPath, so it was the one
  // signed bundle whose entitlements were never asserted to exist.
  it('requires signed entitlements on the Studio bundle', () => {
    const required = source.match(/const requiredEntitlementsByPath = new Map\(\[([\s\S]*?)\]\)/)
    expect(required?.[1]).toBeTruthy()
    expect(required?.[1]).toContain('studioApp')
  })
})

const { stopSmokeChild } = require('./smoke-packaged-electron.cjs') as {
  stopSmokeChild: (
    child: unknown,
    label: string,
    platform?: string,
    killTree?: (pid: number) => void
  ) => Promise<void>
}

describe('packaged app launch smoke cleanup', () => {
  interface FakeStream {
    destroyed: boolean
    destroy(): void
  }
  type FakeChild = EventEmitter & {
    pid: number
    exitCode: number | null
    signalCode: string | null
    stdout: FakeStream
    stderr: FakeStream
    signals: string[]
    unrefCalls: number
    kill(signal: string): boolean
    unref(): void
  }
  function fakeStream(): FakeStream {
    return {
      destroyed: false,
      destroy() {
        this.destroyed = true
      }
    }
  }
  function exitNow(child: FakeChild): void {
    process.nextTick(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
  }
  function fakeChild(pid = 4321): FakeChild {
    const child = new EventEmitter() as FakeChild
    child.pid = pid
    child.exitCode = null
    child.signalCode = null
    child.stdout = fakeStream()
    child.stderr = fakeStream()
    child.signals = []
    child.unrefCalls = 0
    child.kill = (signal: string) => {
      child.signals.push(signal)
      exitNow(child)
      return true
    }
    child.unref = () => {
      child.unrefCalls += 1
    }
    return child
  }

  it('kills the whole process tree on Windows so the app Host sidecar cannot outlive the smoke', async () => {
    const child = fakeChild(777)
    const treeKills: number[] = []
    await stopSmokeChild(child, 'packaged Windows app', 'win32', (pid) => {
      treeKills.push(pid)
      exitNow(child)
    })
    expect(treeKills).toEqual([777])
    expect(child.signals).toEqual([])
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unrefCalls).toBe(1)
  })

  it('keeps the SIGTERM path on other platforms and still releases its pipe ends', async () => {
    const child = fakeChild()
    const treeKills: number[] = []
    await stopSmokeChild(child, 'packaged Linux app', 'linux', (pid) => {
      treeKills.push(pid)
    })
    expect(treeKills).toEqual([])
    expect(child.signals).toEqual(['SIGTERM'])
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unrefCalls).toBe(1)
  })

  it('releases the pipe ends of a child that already exited without touching it', async () => {
    const child = fakeChild()
    child.exitCode = 0
    await stopSmokeChild(child, 'already gone', 'win32', () => {
      throw new Error('must not kill an exited child')
    })
    expect(child.signals).toEqual([])
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unrefCalls).toBe(1)
  })
})
