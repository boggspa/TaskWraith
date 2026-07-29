import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'validate-release.cjs'), 'utf8')

describe('validate-release gate inventory', () => {
  it('directly includes both provider projections, all TypeScript projects, and release guards', () => {
    for (const requiredScript of [
      'verify:kimi-runtime-qualifications',
      'verify:cursor-runtime-qualifications',
      'verify:tui-runtime-policy',
      'guard:platform-path-literals',
      'typecheck',
      'guard:architecture',
      'guard:provider-intent',
      'guard:doctrine-integrity',
      'guard:ios-plist',
      'format:ratchet',
      'test:precommit-hook',
      'test:swift:ios-kit'
    ]) {
      expect(source).toContain(`'${requiredScript}'`)
    }
  })

  it('uses the Windows npm executable and reserves exit 2 for missing prerequisites', () => {
    expect(source).toContain("process.platform === 'win32' ? 'npm.cmd' : 'npm'")
    expect(source).toContain('resolvePlatformCommandInvocation(')
    expect(source).toContain('spawnSync(invocation.command, invocation.arguments')
    expect(source).toContain("result.error?.code === 'ENOENT'")
    expect(source).toContain('process.exit(2)')
  })

  it('fails notarization preflight without an identity and prints literal shell placeholders', () => {
    expect(source).toContain('validateCodeSigningIdentityOutput(output, process.env.CSC_NAME)')
    expect(source).toContain(
      "'  CSC_NAME=$CSC_NAME APPLE_KEYCHAIN_PROFILE=$APPLE_KEYCHAIN_PROFILE npm run build:mac:notarized'"
    )
    expect(source).not.toContain('`  CSC_NAME=$CSC_NAME')
  })
})
