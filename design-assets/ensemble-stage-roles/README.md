# Ensemble Stage Role Icons

Original monoline SVG icons for the compact stage-role markers in Ensemble
participant chips.

Design constraints:

- `24x24` SVG viewBox, rendered at `14x14` in the participant row.
- No baked container or colour.
- Theme-aware linework via `currentColor`.
- `fill="none"` with rounded monoline caps and joins.
- Simple, distinct silhouettes that remain legible at compact size.
- Accessible `<title>` and `<desc>` in every design-source SVG.

| Stage role | SVG source |
| --- | --- |
| Scout | `icons/scout-magnifier.svg` |
| Worker | `icons/worker-wrench.svg` |
| Reviewer | `icons/reviewer-glasses.svg` |
| Background | `icons/background-terminal.svg` |

The desktop runtime keeps inline copies of this geometry in
`src/renderer/src/components/EnsembleParticipantsAboveRow.tsx`. Keep those
copies synchronized when changing these source assets.

This set is intentionally separate from `design-assets/tool-call-icons`; stage
roles and tool-call families are different visual concepts.
