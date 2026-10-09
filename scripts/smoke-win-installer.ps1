param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$InstallDir = (Join-Path $env:TEMP "TaskWraithSmokeInstall"),
  [switch]$AllowUnsigned,
  [string]$PreviousInstallerPath,
  [string]$ExpectedInstallerSha256,
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"

function Assert-ValidSignature([string]$Path, [string]$Label) {
  if (!(Test-Path $Path)) {
    throw "Missing ${Label}: $Path"
  }
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($AllowUnsigned -and $signature.Status -eq "NotSigned") {
    Write-Host "Unsigned Windows release artifact: $Label ($Path)"
    return
  }
  if ($signature.Status -ne "Valid") {
    throw "Invalid Authenticode signature for $Label ($Path): $($signature.Status)"
  }
}

function Wait-CheckedProcess(
  [System.Diagnostics.Process]$Process,
  [string]$Label,
  [int]$TimeoutSeconds
) {
  if (!$Process.WaitForExit($TimeoutSeconds * 1000)) {
    try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
    throw "$Label timed out after $TimeoutSeconds seconds."
  }
  if ($Process.ExitCode -ne 0) {
    throw "$Label exited with code $($Process.ExitCode)"
  }
}

if (!(Test-Path $InstallerPath)) {
  throw "Installer not found: $InstallerPath"
}

$resolvedInstaller = (Resolve-Path $InstallerPath).Path
if ($ExpectedInstallerSha256) {
  if ($ExpectedInstallerSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw "Expected installer SHA-256 is malformed."
  }
  if ((Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash -ne $ExpectedInstallerSha256) {
    throw "Installer SHA-256 does not match the frozen handoff payload."
  }
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$installerGuid = "47ec134f-b60a-536f-9f7e-125e215054fe"
$installRegistryPath = "HKCU:\Software\$installerGuid"
$uninstallRegistryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$installerGuid"

function Assert-InstallRegistration {
  $registration = Get-ItemProperty -LiteralPath $installRegistryPath
  $registeredPath = [System.IO.Path]::GetFullPath($registration.InstallLocation).TrimEnd([char]'\')
  if ($registeredPath -ne $InstallDir.TrimEnd([char]'\')) {
    throw "Installer did not retain the expected installation directory: $registeredPath"
  }
  $uninstall = Get-ItemProperty -LiteralPath $uninstallRegistryPath
  if ($uninstall.UninstallString.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Uninstall registration does not point to the retained installation directory."
  }
  if (Test-Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\8efbcc00-341c-5be7-8c7f-bea2add339f7") {
    throw "Public app identity created a duplicate uninstall registration."
  }
}

if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Assert-ValidSignature $resolvedInstaller "installer"

$appExe = Join-Path $InstallDir "TaskWraith.exe"
$uninstaller = Join-Path $InstallDir "Uninstall TaskWraith.exe"
$app = $null
$uninstalled = $false
$profileFixture = $null

try {
  if ($PreviousInstallerPath) {
    if (!$ExpectedInstallerSha256) {
      throw "Migration smoke requires the target's frozen SHA-256."
    }
    $previousInstaller = (Resolve-Path $PreviousInstallerPath).Path
    Assert-ValidSignature $previousInstaller "previous installer"
    $previous = Start-Process -FilePath $previousInstaller -ArgumentList @("/S", "/currentuser", "/D=$InstallDir") -PassThru
    Wait-CheckedProcess $previous "Previous installer" $TimeoutSeconds
    Assert-InstallRegistration
    $app = Start-Process -FilePath $appExe -PassThru
    Start-Sleep -Seconds 4
    if ($app.HasExited) { throw "Previous app exited during migration setup." }
    $app.CloseMainWindow() | Out-Null
    if (!$app.WaitForExit(15000)) {
      Stop-Process -Id $app.Id -Force
      $app.WaitForExit(5000) | Out-Null
    }
    $app = $null
    $profileRoot = Join-Path $env:APPDATA "TaskWraith"
    New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
    $profileFixture = Join-Path $profileRoot ("installer-migration-smoke-" + [guid]::NewGuid().ToString("N") + ".bin")
    [System.IO.File]::WriteAllText($profileFixture, "Opaque installer preservation fixture.")
    $profileHash = (Get-FileHash -LiteralPath $profileFixture -Algorithm SHA256).Hash
    # Omit /D deliberately: the new identity must discover the old custom path.
    $installArgs = @("/S", "/currentuser")
  } else {
    $installArgs = @("/S", "/currentuser", "/D=$InstallDir")
  }
  $install = Start-Process -FilePath $resolvedInstaller -ArgumentList $installArgs -PassThru
  Wait-CheckedProcess $install "Installer" $TimeoutSeconds
  Assert-InstallRegistration

  Assert-ValidSignature $appExe "installed app"
  Assert-ValidSignature $uninstaller "uninstaller"

  $installedProductVersion = (Get-Item -LiteralPath $appExe).VersionInfo.ProductVersion
  & node (Join-Path $PSScriptRoot 'verify-installed-windows.cjs') $InstallDir $resolvedInstaller $installedProductVersion
  if ($LASTEXITCODE -ne 0) { throw "Installed application identity verification failed." }

  $app = Start-Process -FilePath $appExe -PassThru
  Start-Sleep -Seconds 4
  if ($app.HasExited) {
    throw "Installed app exited during launch smoke with code $($app.ExitCode)"
  }
  $app.CloseMainWindow() | Out-Null
  if (!$app.WaitForExit(15000)) {
    Stop-Process -Id $app.Id -Force
    $app.WaitForExit(5000) | Out-Null
  }

  if ($profileFixture) {
    if (!(Test-Path -LiteralPath $profileFixture) -or (Get-FileHash -LiteralPath $profileFixture -Algorithm SHA256).Hash -ne $profileHash) {
      throw "Installer replacement changed or removed the existing profile fixture."
    }
    Write-Host "Windows identity replacement preserved custom install path, one registration, and profile SHA-256 $profileHash"
  }

  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -PassThru
  Wait-CheckedProcess $uninstall "Uninstaller" $TimeoutSeconds
  $uninstalled = $true
  if (Test-Path $appExe) {
    throw "App executable still exists after uninstall: $appExe"
  }
  if ((Test-Path $installRegistryPath) -or (Test-Path $uninstallRegistryPath)) {
    throw "Installer registration remains after uninstall."
  }
} finally {
  if ($app -and !$app.HasExited) {
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  }
  if (!$uninstalled -and (Test-Path $uninstaller)) {
    try {
      $cleanup = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -PassThru
      Wait-CheckedProcess $cleanup "Cleanup uninstaller" $TimeoutSeconds
    } catch {
      Write-Warning "Installer smoke cleanup failed: $_"
    }
  }
  if ($profileFixture -and (Test-Path -LiteralPath $profileFixture)) {
    Remove-Item -LiteralPath $profileFixture -Force
  }
}

Write-Host "Windows installer smoke ok: $resolvedInstaller"
