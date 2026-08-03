# App Drive interference harness

**Candidate-only** automation that emits machine-readable per-app interference
results for the Background Drive prototype.

Paired with: `prototypes/appdrive-background/`.

## What it measures

For each app entry:

| Dimension | Pass means |
| --- | --- |
| `focus` | Focused window id unchanged |
| `frontmostApp` | Frontmost app unchanged |
| `hostCursor` | Host cursor position unchanged |
| `keyboardTarget` | Keyboard-target PID unchanged |
| `clipboardHash` | Clipboard hash unchanged (no contents stored) |
| `activation` | Target did not become active |
| `targetSuccess` | Action hit the intended fixture target |
| `targetScopedHumanArbitration` | Human-on-target vs elsewhere can be discriminated |

Dry-run never sets `nonInterferenceProven: true`.

## Commands

```bash
# Default dry-run over sample catalog → JSON on stdout
node scripts/appdrive-interference/run-interference-harness.cjs --json

# Write report
node scripts/appdrive-interference/run-interference-harness.cjs --out scripts/appdrive-interference/sample-results/dry-run-fixture.json

# Observe-only
node scripts/appdrive-interference/run-interference-harness.cjs --observe-only --json

# Live gates (still refuses native post — no silent fallback)
APPDRIVE_BG_ALLOW_POST=1 node scripts/appdrive-interference/run-interference-harness.cjs \\
  --allow-live-post --fixture-pid 99901 --json
```

## Hard refusals

- Global `CGEventPost`
- Cursor warp
- Clipboard write/type
- Activate/raise
- Agent-triggered permission prompts
- Silent Background → Foreground fallback

## Tests

```bash
npx vitest run scripts/appdrive-interference
```

## Acceptance note for product

Background Drive must **not** be advertised as non-disruptive until a **live**
harness run (user-invoked, fixture-constrained) yields
`nonInterferenceProven: true` across the allowlisted app matrix, including
target-scoped human arbitration — which does **not** exist in production
native HID idle sensing today.
