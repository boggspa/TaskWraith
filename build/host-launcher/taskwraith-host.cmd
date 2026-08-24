@echo off
setlocal EnableExtensions
rem TaskWraith production Host launcher — Node sidecar only.
rem Uses resources\tui-runtime\win32-<arch>\node.exe and never Electron or
rem ELECTRON_RUN_AS_NODE (RunAsNode is fused off on the App binary).

set "BIN_DIR=%~dp0"
set "RESOURCES_DIR=%BIN_DIR%.."
for %%I in ("%RESOURCES_DIR%") do set "RESOURCES_DIR=%%~fI"
set "CLI_JS=%RESOURCES_DIR%\host\host-runtime\cli.js"
set "RUNTIME_ROOT=%RESOURCES_DIR%\tui-runtime"

if not exist "%CLI_JS%" (
  echo taskwraith-host: packaged production Host payload missing at: 1>&2
  echo   %CLI_JS% 1>&2
  exit /b 1
)

set "NODE_BIN="
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
  if exist "%RUNTIME_ROOT%\win32-arm64\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\win32-arm64\node.exe"
) else (
  if exist "%RUNTIME_ROOT%\win32-x64\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\win32-x64\node.exe"
)
if not defined NODE_BIN if exist "%RUNTIME_ROOT%\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\node.exe"

if not defined NODE_BIN (
  echo taskwraith-host: packaged Node runtime missing under: 1>&2
  echo   %RUNTIME_ROOT% 1>&2
  echo TaskWraith does not use ELECTRON_RUN_AS_NODE ^(RunAsNode fuse disabled^). 1>&2
  exit /b 1
)

"%NODE_BIN%" "%CLI_JS%" serve --mode production %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
