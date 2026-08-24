# TaskWraith production Host launcher — Node sidecar only.
# Uses Resources\tui-runtime\win32-<arch>\node.exe and never Electron or
# ELECTRON_RUN_AS_NODE (RunAsNode is fused off on the App binary).

$ErrorActionPreference = 'Stop'

$binDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$resourcesDir = (Resolve-Path (Join-Path $binDir '..')).Path
$cliJs = Join-Path $resourcesDir 'host\host-runtime\cli.js'
$runtimeRoot = Join-Path $resourcesDir 'tui-runtime'

if (-not (Test-Path -LiteralPath $cliJs -PathType Leaf)) {
  [Console]::Error.WriteLine("taskwraith-host: packaged production Host payload missing at:")
  [Console]::Error.WriteLine("  $cliJs")
  exit 1
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$candidates = @(
  (Join-Path $runtimeRoot "win32-$arch\node.exe"),
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
  [Console]::Error.WriteLine("taskwraith-host: packaged Node runtime missing under:")
  [Console]::Error.WriteLine("  $runtimeRoot")
  [Console]::Error.WriteLine("TaskWraith does not use ELECTRON_RUN_AS_NODE (RunAsNode fuse disabled).")
  exit 1
}

if ($args.Count -gt 0 -and $args[0] -eq 'stop') {
  $stopArgs = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
  & $nodeBin $cliJs stop @stopArgs
} else {
  & $nodeBin $cliJs serve --mode production @args
}
exit $LASTEXITCODE
