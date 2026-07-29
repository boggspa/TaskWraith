param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$InstallDir = (Join-Path $env:TEMP "TaskWraithSmokeInstall"),
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"

function Assert-ValidSignature([string]$Path, [string]$Label) {
  if (!(Test-Path $Path)) {
    throw "Missing $Label: $Path"
  }
  $signature = Get-AuthenticodeSignature -FilePath $Path
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
if (Test-Path $InstallDir) {
  Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Assert-ValidSignature $resolvedInstaller "installer"

$appExe = Join-Path $InstallDir "TaskWraith.exe"
$uninstaller = Join-Path $InstallDir "Uninstall TaskWraith.exe"
$app = $null
$uninstalled = $false

try {
  $installArgs = @("/S", "/D=$InstallDir")
  $install = Start-Process -FilePath $resolvedInstaller -ArgumentList $installArgs -PassThru
  Wait-CheckedProcess $install "Installer" $TimeoutSeconds

  Assert-ValidSignature $appExe "installed app"
  Assert-ValidSignature $uninstaller "uninstaller"

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

  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -PassThru
  Wait-CheckedProcess $uninstall "Uninstaller" $TimeoutSeconds
  $uninstalled = $true
  if (Test-Path $appExe) {
    throw "App executable still exists after uninstall: $appExe"
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
}

Write-Host "Windows installer smoke ok: $resolvedInstaller"
