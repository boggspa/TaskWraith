# TaskWraith TUI launcher (Developer Preview) — PowerShell.
# Uses the official Node runtime under resources\tui-runtime\ (no system Node,
# no ELECTRON_RUN_AS_NODE — RunAsNode fuse is disabled on the App binary).
#
# Layout (electron-builder extraResources):
#   <install>\resources\bin\tw.ps1
#   <install>\resources\tui\tui\cli.js
#   <install>\resources\tui-runtime\win32-<arch>\node.exe

$ErrorActionPreference = 'Stop'

$binDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$resourcesDir = (Resolve-Path (Join-Path $binDir '..')).Path
$cliJs = Join-Path $resourcesDir 'tui\tui\cli.js'
$runtimeRoot = Join-Path $resourcesDir 'tui-runtime'

if (-not (Test-Path -LiteralPath $cliJs -PathType Leaf)) {
  [Console]::Error.WriteLine("taskwraith: packaged TUI payload missing at:")
  [Console]::Error.WriteLine("  $cliJs")
  [Console]::Error.WriteLine("This launcher is for an installed TaskWraith package (Developer Preview).")
  [Console]::Error.WriteLine("From a checkout, use: npm run tui -- [options]  or  npx tw [options]")
  exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$candidates = @(
  (Join-Path $runtimeRoot "win32-$arch\node.exe"),
  (Join-Path $runtimeRoot 'win32-x64\node.exe'),
  (Join-Path $runtimeRoot 'win32-arm64\node.exe'),
  (Join-Path $runtimeRoot 'node.exe')
)

$nodeBin = $null
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $nodeBin = $candidate
    break
  }
}

if (-not $nodeBin) {
  [Console]::Error.WriteLine("taskwraith: packaged TUI Node runtime missing under:")
  [Console]::Error.WriteLine("  $runtimeRoot")
  [Console]::Error.WriteLine("Expected: tui-runtime\win32-x64\node.exe or win32-arm64\node.exe")
  [Console]::Error.WriteLine("Run npm run prepare:tui-runtime before electron-builder.")
  [Console]::Error.WriteLine("TaskWraith does not use ELECTRON_RUN_AS_NODE (RunAsNode fuse disabled).")
  exit 1
}

& $nodeBin $cliJs @args
exit $LASTEXITCODE
