import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'smoke-win-installer.ps1'),
  'utf8'
)

describe('Windows installer lifecycle smoke contract', () => {
  it('bounds installer and uninstaller waits and cleans up on failure', () => {
    expect(source).toContain('Wait-CheckedProcess $install "Installer" $TimeoutSeconds')
    expect(source).toContain('Wait-CheckedProcess $uninstall "Uninstaller" $TimeoutSeconds')
    expect(source).toContain('finally {')
    expect(source).toContain('Wait-CheckedProcess $cleanup "Cleanup uninstaller"')
  })
})
