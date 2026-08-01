import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseImports,
  collectImportViolations,
  collectDirectForbiddenImports,
  bundleScanTargets,
  packagedRuntimeLicenseViolations,
  scanBufferForSecrets,
  PEM_PRIVATE_KEY_BODY,
  FORBIDDEN_MODULE_MATCHERS,
  SERVER_GRAPH_FORBIDDEN,
  MAIN_DIRECT_FORBIDDEN,
  GUARDED_ENTRY
}: {
  parseImports: (source: string) => Array<{ specifier: string; typeOnly: boolean }>
  collectImportViolations: (entry: string, matchers: RegExp[]) => string[]
  collectDirectForbiddenImports: (dirs: string[], matchers: RegExp[]) => string[]
  bundleScanTargets: (repoRoot?: string) => string[]
  packagedRuntimeLicenseViolations: (repoRoot?: string) => string[]
  scanBufferForSecrets: (label: string, text: string, fingerprints: string[]) => string[]
  PEM_PRIVATE_KEY_BODY: RegExp
  FORBIDDEN_MODULE_MATCHERS: RegExp[]
  SERVER_GRAPH_FORBIDDEN: RegExp[]
  MAIN_DIRECT_FORBIDDEN: RegExp[]
  GUARDED_ENTRY: string
} = require('./guard-no-bundled-secrets.cjs')

describe('guard-no-bundled-secrets: release artifact targets', () => {
  it('scans packaged app.asar and extra resources but excludes the standalone Node binary', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-guard-artifacts-'))
    const resources = path.join(repoRoot, 'dist', 'linux-unpacked', 'resources')
    fs.mkdirSync(path.join(resources, 'tui'), { recursive: true })
    fs.mkdirSync(path.join(resources, 'tui-runtime', 'linux-x64'), { recursive: true })
    fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'example'), {
      recursive: true
    })
    fs.writeFileSync(path.join(resources, 'app.asar'), 'bundle')
    fs.writeFileSync(path.join(resources, 'tui', 'cli.js'), 'cli')
    fs.writeFileSync(path.join(resources, 'tui-runtime', 'RUNTIME.json'), '{}')
    fs.writeFileSync(path.join(resources, 'tui-runtime', 'linux-x64', 'node'), 'runtime')
    fs.writeFileSync(
      path.join(resources, 'app.asar.unpacked', 'node_modules', 'example', 'payload.js'),
      'unpacked payload'
    )

    try {
      const targets = bundleScanTargets(repoRoot).map((target) =>
        path.relative(repoRoot, target).replace(/\\/g, '/')
      )
      expect(targets).toEqual(
        expect.arrayContaining([
          'dist/linux-unpacked/resources/app.asar',
          'dist/linux-unpacked/resources/tui/cli.js',
          'dist/linux-unpacked/resources/tui-runtime/RUNTIME.json',
          'dist/linux-unpacked/resources/app.asar.unpacked/node_modules/example/payload.js'
        ])
      )
      expect(targets).not.toContain('dist/linux-unpacked/resources/tui-runtime/linux-x64/node')
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('requires archive-bound Node license metadata in every packaged runtime', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-guard-license-'))
    const runtime = path.join(
      repoRoot,
      'dist',
      'linux-unpacked',
      'resources',
      'tui-runtime',
      'linux-x64'
    )
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(
      path.join(repoRoot, 'dist', 'linux-unpacked', 'resources', 'app.asar'),
      'bundle'
    )
    try {
      expect(packagedRuntimeLicenseViolations(repoRoot)).toEqual([
        expect.stringContaining('missing Node distribution LICENSE')
      ])
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('guard-no-bundled-secrets: PEM body detection', () => {
  it('does NOT flag the bare BEGIN marker (the Tier-1 validator literals)', () => {
    // The exact shape present 3x in the shipped bundle today.
    const text = `const m = '-----BEGIN PRIVATE KEY-----'; if (pem.startsWith(m)) ok()`
    expect(PEM_PRIVATE_KEY_BODY.test(text)).toBe(false)
    expect(scanBufferForSecrets('x', text, [])).toEqual([])
  })

  it('flags a real PEM private-key body with escaped newlines (as bundled)', () => {
    const line = `MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT${'A'.repeat(40)}`
    const pem = `"-----BEGIN PRIVATE KEY-----\\n${line}\\n${line}\\n-----END PRIVATE KEY-----\\n"`
    expect(PEM_PRIVATE_KEY_BODY.test(pem)).toBe(true)
    expect(scanBufferForSecrets('bundle', pem, [])).toContain(
      'bundle: contains a PEM PRIVATE KEY body'
    )
  })

  it('flags an EC private key body too', () => {
    const line = 'A'.repeat(60)
    const pem = `-----BEGIN EC PRIVATE KEY-----\n${line}\n${line}\n-----END EC PRIVATE KEY-----`
    expect(PEM_PRIVATE_KEY_BODY.test(pem)).toBe(true)
  })

  it('flags a known fingerprint without echoing its value', () => {
    const findings = scanBufferForSecrets('bundle', 'noise KEYID12345 noise', ['KEYID12345'])
    expect(findings.length).toBe(1)
    expect(findings[0]).not.toContain('KEYID12345')
  })
})

describe('guard-no-bundled-secrets: import parsing', () => {
  it('treats `import type`/`export type` as erased and everything else as runtime', () => {
    const src = [
      "import type { A } from './types'",
      "import { b, type C } from './impl'",
      "import './side'",
      "export { d } from './reexport'",
      "export type { E } from './tre'"
    ].join('\n')
    const imps = parseImports(src)
    const by = (s: string): { specifier: string; typeOnly: boolean } | undefined =>
      imps.find((i) => i.specifier === s)
    expect(by('./types')?.typeOnly).toBe(true)
    // inline `type C` → conservatively a value import (we never want even that
    // from the impl module).
    expect(by('./impl')?.typeOnly).toBe(false)
    expect(by('./side')?.typeOnly).toBe(false)
    expect(by('./reexport')?.typeOnly).toBe(false)
    expect(by('./tre')?.typeOnly).toBe(true)
  })
})

describe('guard-no-bundled-secrets: forbidden-import boundary', () => {
  it('passes for the real relay server.ts (no gateway impl in its graph)', () => {
    expect(collectImportViolations(GUARDED_ENTRY, FORBIDDEN_MODULE_MATCHERS)).toEqual([])
  })

  it('catches a value import of the gateway impl', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-guard-'))
    fs.writeFileSync(path.join(dir, 'apnsGateway.ts'), 'export const x = 1\n')
    const entry = path.join(dir, 'server.ts')
    fs.writeFileSync(entry, "import { x } from './apnsGateway'\n")
    const violations = collectImportViolations(entry, [/\/apnsGateway\.ts$/])
    expect(violations.length).toBe(1)
    expect(violations[0]).toContain('forbidden module')
  })

  it('catches even a type import of the gateway impl module (types belong elsewhere)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-guard-'))
    fs.writeFileSync(path.join(dir, 'apnsGateway.ts'), 'export type T = number\n')
    const entry = path.join(dir, 'server.ts')
    fs.writeFileSync(entry, "import type { T } from './apnsGateway'\n")
    expect(collectImportViolations(entry, [/\/apnsGateway\.ts$/]).length).toBe(1)
  })

  it('allows a type import from the types module', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-guard-'))
    fs.writeFileSync(path.join(dir, 'apnsGatewayTypes.ts'), 'export interface A { x: number }\n')
    const entry = path.join(dir, 'server.ts')
    fs.writeFileSync(entry, "import type { A } from './apnsGatewayTypes'\n")
    expect(collectImportViolations(entry, [/\/apnsGateway\.ts$/])).toEqual([])
  })

  it('does NOT traverse into a type-only-imported module to find a deeper violation', () => {
    // server type-imports mid (erased → never bundled), so mid's value import of
    // the impl can't bundle it. No violation.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-guard-'))
    fs.writeFileSync(path.join(dir, 'apnsGateway.ts'), 'export const x = 1\n')
    fs.writeFileSync(
      path.join(dir, 'mid.ts'),
      "import { x } from './apnsGateway'\nexport type M = typeof x\n"
    )
    const entry = path.join(dir, 'server.ts')
    fs.writeFileSync(entry, "import type { M } from './mid'\n")
    expect(collectImportViolations(entry, [/\/apnsGateway\.ts$/])).toEqual([])
  })
})

describe('guard-no-bundled-secrets: matcher scoping (keyless send-core)', () => {
  it('forbids the send-core in the server.ts graph but allows it in Electron main', () => {
    const sendCorePath = '/repo/src/shared/apns/apnsSendCore.ts'
    expect(SERVER_GRAPH_FORBIDDEN.some((re) => re.test(sendCorePath))).toBe(true)
    expect(MAIN_DIRECT_FORBIDDEN.some((re) => re.test(sendCorePath))).toBe(false)
  })

  it('passes the real src/main tree under the main rules (Tier-1 imports the send-core)', () => {
    // Http2ApnsPusher (src/main) legitimately imports apnsSendCore; the main
    // flat scan must flag only the gateway impl / .p8, never the keyless core.
    expect(
      collectDirectForbiddenImports(['src/main', 'src/preload'], MAIN_DIRECT_FORBIDDEN)
    ).toEqual([])
  })
})
