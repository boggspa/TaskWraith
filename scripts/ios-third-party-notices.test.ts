import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  APP_LICENSE_OUTPUT_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  PACKAGE_RESOLVED_RELATIVE_PATHS,
  THIRD_PARTY_OUTPUT_RELATIVE_PATH,
  verifyIosNotices
} = require('./ios-third-party-notices.cjs') as {
  APP_LICENSE_OUTPUT_RELATIVE_PATH: string
  MANIFEST_RELATIVE_PATH: string
  PACKAGE_RESOLVED_RELATIVE_PATHS: string[]
  THIRD_PARTY_OUTPUT_RELATIVE_PATH: string
  verifyIosNotices: (options: { repoRoot: string }) => {
    packageCount: number
    noticeSourceCount: number
  }
}

const REPO_ROOT = path.resolve(__dirname, '..')
const temporaryRoots: string[] = []

function copyFixture(): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-ios-notices-'))
  temporaryRoots.push(fixtureRoot)

  const files = [
    'LICENSE',
    ...PACKAGE_RESOLVED_RELATIVE_PATHS,
    APP_LICENSE_OUTPUT_RELATIVE_PATH,
    THIRD_PARTY_OUTPUT_RELATIVE_PATH
  ]
  for (const relativePath of files) {
    const target = path.join(fixtureRoot, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, relativePath), target)
  }

  const licenseSourceDirectory = path.dirname(MANIFEST_RELATIVE_PATH)
  fs.cpSync(
    path.join(REPO_ROOT, licenseSourceDirectory),
    path.join(fixtureRoot, licenseSourceDirectory),
    { recursive: true }
  )
  return fixtureRoot
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

describe('iOS third-party notices', () => {
  it('verifies the checked-in resolved graph and generated resources', () => {
    const result = verifyIosNotices({ repoRoot: REPO_ROOT })

    expect(result.packageCount).toBe(3)
    expect(result.noticeSourceCount).toBe(5)
  })

  it('fails when the two shipping Swift graphs diverge', () => {
    const fixtureRoot = copyFixture()
    const resolvedPath = path.join(fixtureRoot, PACKAGE_RESOLVED_RELATIVE_PATHS[0])
    const resolved = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
    resolved.pins.push({
      identity: 'unmapped-package',
      kind: 'remoteSourceControl',
      location: 'https://example.invalid/unmapped-package',
      state: { revision: 'a'.repeat(40), version: '1.0.0' }
    })
    fs.writeFileSync(resolvedPath, JSON.stringify(resolved))

    expect(() => verifyIosNotices({ repoRoot: fixtureRoot })).toThrow(/does not match/)
  })

  it('fails when a resolved package has no explicit notice mapping', () => {
    const fixtureRoot = copyFixture()
    for (const relativePath of PACKAGE_RESOLVED_RELATIVE_PATHS) {
      const resolvedPath = path.join(fixtureRoot, relativePath)
      const resolved = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
      resolved.pins.push({
        identity: 'unmapped-package',
        kind: 'remoteSourceControl',
        location: 'https://example.invalid/unmapped-package',
        state: { revision: 'a'.repeat(40), version: '1.0.0' }
      })
      fs.writeFileSync(resolvedPath, JSON.stringify(resolved))
    }

    expect(() => verifyIosNotices({ repoRoot: fixtureRoot })).toThrow(/not fully mapped to notices/)
  })

  it('fails when a preserved upstream notice changes', () => {
    const fixtureRoot = copyFixture()
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, MANIFEST_RELATIVE_PATH), 'utf8')
    )
    const sourcePath = path.join(fixtureRoot, manifest.packages[0].notices[0].path)
    fs.appendFileSync(sourcePath, '\ntampered\n')

    expect(() => verifyIosNotices({ repoRoot: fixtureRoot })).toThrow(/hash mismatch/)
  })

  it('fails when a bundled resource is stale', () => {
    const fixtureRoot = copyFixture()
    fs.appendFileSync(path.join(fixtureRoot, THIRD_PARTY_OUTPUT_RELATIVE_PATH), 'stale')

    expect(() => verifyIosNotices({ repoRoot: fixtureRoot })).toThrow(/is stale/)
  })

  it('is wired into CI and verifies both archive payloads', () => {
    const packageJson = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    const archiveScript = fs.readFileSync(
      path.join(REPO_ROOT, 'ios/TaskWraithApp/scripts/archive-testflight.sh'),
      'utf8'
    )

    expect(packageJson).toContain('guard:third-party-notices')
    expect(packageJson).toContain('npm run guard:third-party-notices')
    expect(archiveScript).toContain('node "$repo_root/scripts/ios-third-party-notices.cjs"')
    expect(archiveScript.match(/verify_bundled_notice \\\n/g)).toHaveLength(4)
  })
})
