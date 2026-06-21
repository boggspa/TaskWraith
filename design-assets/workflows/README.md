# Workflow Glyphs

Original monoline glyphs for TaskWraith workflow and automation surfaces.
Workflows are a first-class chat/run type in 1.6.0 with a sidebar section,
welcome surface, compose controls, scheduled recovery, and optional Run as
ensemble where enabled.

Design constraints:

- `24x24` SVG viewBox.
- No baked container.
- Theme-aware linework via `currentColor` / `--workflow-accent`.
- Rounded monoline joins, compatible with sidebar and toolbar sizes.
- Unique mnemonic geometry rather than platform or SF Symbols copies.

Assets:

- `workflow-monoline.svg`: trigger, decision, run block, and return-path mnemonic for Workflows.
- `icons/action-*.svg`: selected-workflow action glyphs for run, pause/resume, cadence, cancel, and delete.
- `icons/status-*.svg`: compact status glyphs for workflow execution counters.
- `workflow-glyphs.catalog.svg`: quick review sheet with dark and light previews.

After changing the source SVG, sync any inline desktop copy in
`src/renderer/src/components/AppChromeSymbols.tsx`.
