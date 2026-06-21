# Windows Parity QA

Use this matrix before promoting a Windows release build.

## Install And Update

- Windows 11 ARM64 in Parallels: install `TaskWraith-*-win-arm64-setup.exe`, launch, uninstall, reinstall.
- Windows 11 x64: install `TaskWraith-*-win-x64-setup.exe`, launch, uninstall, reinstall.
- Windows 10 x64: install `TaskWraith-*-win-x64-setup.exe`, launch, uninstall, reinstall.
- Run `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-win-installer.ps1 -InstallerPath <installer>`.
- For signed builds, confirm installer, installed `TaskWraith.exe`, and
  uninstaller Authenticode signatures are valid. For intentionally unsigned
  preview artifacts, confirm release notes and filenames clearly label them as
  unsigned.
- Confirm x64 hosts only see x64 update feeds and ARM64 hosts only see ARM64 update feeds.

## Visual Baselines

Capture each at 100%, 125%, 150%, and 200% scale where the OS supports it:

- Welcome screen with dashboard and heatmap.
- Transcript with user, assistant, tool, and system messages.
- Composer default, Codex, Claude, Grok, and Ensemble styles.
- Ensemble participant row and handed-back/system messages.
- Settings Appearance, General, MCP, and update/changelog sheet.
- Approval modal and ask-user-question modal.
- File editor and diff popout.
- Multiview with two to four panes, including per-pane composer routing.
- Workflows welcome, sidebar section, scheduled recovery banner, and Run as
  ensemble when the feature gate is enabled.
- Reusable notification cards on welcome/first-launch surfaces.
- Provider paths for Codex, Claude, Kimi, Grok, Cursor, local Ollama, and the
  retired-Gemini historical state.

## Themes And Materials

- Light and dark system themes.
- TaskWraith solid, soft glass, native glass, obsidian, alabaster, and system appearances.
- Windows 11 mica/tabbed material with native frame controls.
- Windows 10 titlebar/material fallback.
- Windows High Contrast / `forced-colors: active`.

## Native Feature Gates

- Attach app and Screen Watch controls are disabled with “Appwatch/Appshots are macOS-only in v1.”
- Appwatch/Appshots MCP calls return structured unsupported results without approval prompts.
- File-based creative parsing remains visible and usable when the underlying file/runtime exists.
- AppleEvents, Final Cut Pro, Logic Pro, and live native bridge controls are hidden or explicitly annotated as macOS-only.
