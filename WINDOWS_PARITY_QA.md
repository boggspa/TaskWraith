# Windows Parity QA

Use this reusable template before promoting a Windows release build. A blank,
`Pending`, or `Not run` field is not a pass. Copy the template for each release;
do not carry results or evidence forward from an earlier version.

## Release Record

- Version: `TBD`
- Candidate commit/tag: `TBD`
- Test cycle started (UTC): `TBD`
- Test cycle completed (UTC): `TBD`
- QA owner: `TBD`
- Overall result: `Not run` (`Pass` / `Fail` / `Blocked` / `Not run`)
- Evidence location: `TBD`
- Blocking issues or release notes: `TBD`

## Artifact And Signing Record

Record the exact candidate bytes tested. Verify checksums independently rather
than copying an unverified value from the build output.

| Architecture | Artifact filename | SHA-256 | File size | Signing identity | Signature result | Update-feed URL/build | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows x64 | `TBD` | `TBD` | `TBD` | `TBD` | `Not checked` | `TBD` | `Not run` |
| Windows ARM64 | `TBD` | `TBD` | `TBD` | `TBD` | `Not checked` | `TBD` | `Not run` |

For intentionally unsigned preview artifacts, record `Unsigned preview` under
Signing identity and confirm that both the filename and release notes disclose
that status.

## Runner Matrix

Use one row per tested environment. The runner field should name the person or
automation job that produced the evidence.

| Environment | Host / hypervisor | OS build | Architecture | Display scales | Runner | Date (UTC) | Result | Evidence / issue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows 11 | `TBD` | `TBD` | ARM64 | 100–200% | `TBD` | `TBD` | `Not run` | `TBD` |
| Windows 11 | `TBD` | `TBD` | x64 | 100–200% | `TBD` | `TBD` | `Not run` | `TBD` |
| Windows 10 | `TBD` | `TBD` | x64 | 100–200% | `TBD` | `TBD` | `Not run` | `TBD` |

Allowed results are `Pass`, `Fail`, `Blocked`, and `Not run`. A release passes
this template only when every required environment and checklist item has a
named runner, dated evidence, and a passing result or a documented release
exception approved by the release owner.

## Install And Update

- Windows 11 ARM64 in Parallels: install the recorded ARM64 artifact, launch,
  uninstall, and reinstall. Result/evidence: `Not run` / `TBD`.
- Windows 11 x64: install the recorded x64 artifact, launch, uninstall, and
  reinstall. Result/evidence: `Not run` / `TBD`.
- Windows 10 x64: install the recorded x64 artifact, launch, uninstall, and
  reinstall. Result/evidence: `Not run` / `TBD`.
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
- Provider paths for Codex, Claude, Grok, local Ollama, Path-B managed Cursor,
  and admission-gated Kimi, including the packaged source-ahead Kimi-unavailable
  state while its commissioned qualification roster is empty; plus the
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

## Sign-Off

- Required environments complete: `No`
- Artifact checksums verified: `No`
- Signing state verified and documented: `No`
- Update architecture routing verified: `No`
- Accessibility and visual evidence reviewed: `No`
- Open blockers: `TBD`
- Release owner: `TBD`
- Final decision: `Not run`
- Decision date (UTC): `TBD`
