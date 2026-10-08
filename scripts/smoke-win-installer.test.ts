import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'smoke-win-installer.ps1'),
  'utf8'
)

describe('Windows installer lifecycle smoke contract', () => {
  it.runIf(process.platform === 'win32')('parses with the native Windows PowerShell parser', () => {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$tokens = $null; $parseErrors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:TASKWRAITH_INSTALLER_SMOKE_SCRIPT, [ref]$tokens, [ref]$parseErrors) | Out-Null; if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }'
      ],
      {
        env: {
          ...process.env,
          TASKWRAITH_INSTALLER_SMOKE_SCRIPT: path.join(
            process.cwd(),
            'scripts',
            'smoke-win-installer.ps1'
          )
        },
        timeout: 30_000,
        stdio: 'pipe'
      }
    )
  })

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
