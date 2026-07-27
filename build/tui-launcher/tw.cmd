@echo off
setlocal EnableExtensions
rem TaskWraith TUI launcher (Developer Preview) — Windows cmd.
rem Uses the official Node runtime under resources\tui-runtime\ (no system Node,
rem no ELECTRON_RUN_AS_NODE — RunAsNode fuse is disabled on the App binary).
rem
rem Layout (electron-builder extraResources):
rem   <install>\resources\bin\tw.cmd
rem   <install>\resources\tui\tui\cli.js
rem   <install>\resources\tui-runtime\win32-<arch>\node.exe

set "BIN_DIR=%~dp0"
set "RESOURCES_DIR=%BIN_DIR%.."
for %%I in ("%RESOURCES_DIR%") do set "RESOURCES_DIR=%%~fI"
set "CLI_JS=%RESOURCES_DIR%\tui\tui\cli.js"
set "RUNTIME_ROOT=%RESOURCES_DIR%\tui-runtime"

if not exist "%CLI_JS%" (
  echo taskwraith: packaged TUI payload missing at: 1>&2
  echo   %CLI_JS% 1>&2
  echo This launcher is for an installed TaskWraith package ^(Developer Preview^). 1>&2
  echo From a checkout, use: npm run tui -- [options]  or  npx tw [options] 1>&2
  exit /b 1
)

set "NODE_BIN="
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
  if exist "%RUNTIME_ROOT%\win32-arm64\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\win32-arm64\node.exe"
) else (
  if exist "%RUNTIME_ROOT%\win32-x64\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\win32-x64\node.exe"
)
if not defined NODE_BIN if exist "%RUNTIME_ROOT%\win32-x64\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\win32-x64\node.exe"
if not defined NODE_BIN if exist "%RUNTIME_ROOT%\win32-arm64\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\win32-arm64\node.exe"
if not defined NODE_BIN if exist "%RUNTIME_ROOT%\node.exe" set "NODE_BIN=%RUNTIME_ROOT%\node.exe"

if not defined NODE_BIN (
  echo taskwraith: packaged TUI Node runtime missing under: 1>&2
  echo   %RUNTIME_ROOT% 1>&2
  echo Expected: tui-runtime\win32-x64\node.exe or win32-arm64\node.exe 1>&2
  echo Run npm run prepare:tui-runtime before electron-builder. 1>&2
  echo TaskWraith does not use ELECTRON_RUN_AS_NODE ^(RunAsNode fuse disabled^). 1>&2
  exit /b 1
)

"%NODE_BIN%" "%CLI_JS%" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
