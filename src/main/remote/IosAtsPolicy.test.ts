import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('iOS relay ATS policy', () => {
  const project = readFileSync(resolve(process.cwd(), 'ios/TaskWraithApp/project.yml'), 'utf8')
  const generatedPlist = readFileSync(
    resolve(process.cwd(), 'ios/TaskWraithApp/Generated/Info.plist'),
    'utf8'
  )

  it('keeps the scoped IP/local-network allowance without a global cleartext bypass', () => {
    expect(project).toMatch(/NSAllowsLocalNetworking:\s*true/)
    expect(project).not.toMatch(/NSAllowsArbitraryLoads:\s*true/)
    expect(project).not.toMatch(/NSExceptionAllowsInsecureHTTPLoads:\s*true/)
    expect(generatedPlist).toContain('<key>NSAllowsLocalNetworking</key>')
    expect(generatedPlist).not.toContain('<key>NSAllowsArbitraryLoads</key>')
  })
})
