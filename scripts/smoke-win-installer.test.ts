import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'smoke-win-installer.ps1'),
  'utf8'
)

describe('Windows installer lifecycle smoke contract', () => {
  it('accepts unsigned artifacts only through the explicit release switch', () => {
    expect(source).toContain('[switch]$AllowUnsigned')
    expect(source).toContain('$AllowUnsigned -and $signature.Status -eq "NotSigned"')
    expect(source).toContain('Unsigned Windows release artifact:')
    expect(source).toContain('if ($signature.Status -ne "Valid")')
    expect(source).toContain('throw "Invalid Authenticode signature for $Label')
    expect(source).toContain('Assert-ValidSignature $resolvedInstaller "installer"')
    expect(source).toContain('Assert-ValidSignature $appExe "installed app"')
    expect(source).toContain('Assert-ValidSignature $uninstaller "uninstaller"')
    expect(source).toContain('Missing ${Label}: $Path')
  })

  it('bounds installer and uninstaller waits and cleans up on failure', () => {
    expect(source).toContain('Wait-CheckedProcess $install "Installer" $TimeoutSeconds')
    expect(source).toContain('Wait-CheckedProcess $uninstall "Uninstaller" $TimeoutSeconds')
    expect(source).toContain('finally {')
    expect(source).toContain('Wait-CheckedProcess $cleanup "Cleanup uninstaller"')
  })
})
