# App Drive Background Input Prototype (candidate only)

**Status:** prototype / RFC evidence — **not production**, **not authority**, **not shipped**.

This package implements a **dry-run-first** Background Drive input candidate and the
measurement model needed before anyone can claim non-disruptive control.

It lives under `prototypes/appdrive-background` on purpose:

- No imports from `src/`
- No wiring into NativeWindowCoordinator, lease registry, or MCP tools
- No global `CGEventPost`, cursor warp, clipboard typing, activation/raise, or
  agent-triggered permission prompts
- No silent fallback from Background → Foreground Drive

## Modes (architecture decision)

| Mode                 | Meaning                                                            | This package                         |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| **Background Drive** | Zero host cursor / focus / keyboard / clipboard / activation theft | Prototype + interference schema only |
| **Isolated Drive**   | Independent guest input via VM                                     | Out of scope here                    |
| **Foreground Drive** | Current shipped AX path (frontmost + focused)                      | Not reimplemented                    |

## Default safety posture

1. **Default = dry-run / observe-only** — no events posted.
2. **Live `CGEventPostToPid`** is policy-gated only (not implemented):
   - harness-owned fixture PID
   - explicit user flag `--allow-live-post`
   - env `APPDRIVE_BG_ALLOW_POST=1`
3. If live gates pass but native posting is absent, the prototype **refuses**
   (including silent foreground fallback) rather than improvising.

## Machine-readable interference dimensions

Every per-app result includes all eight:

1. `focus`
2. `frontmostApp`
3. `hostCursor`
4. `keyboardTarget`
5. `clipboardHash` (hash only — never clipboard contents)
6. `activation`
7. `targetSuccess`
8. `targetScopedHumanArbitration`

`nonInterferenceProven` is **false** for any dry-run, and **true** only when a
live run marks every dimension `pass`.

**Important:** production native idle sensing today is **global HID**, not
target-scoped. The harness intentionally fails `targetScopedHumanArbitration`
when scope is `global_hid`, so Background Drive cannot claim
"human on target pauses agent; elsewhere does not" without new sensors.

## Layout

| Path                                      | Role                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `types.ts`                                | Result / snapshot schema                          |
| `fixtureTarget.ts`                        | Harness-owned fixture identity                    |
| `backgroundInputPolicy.ts`                | Hard refusals + live triple-gate                  |
| `cgeventPostToPid.ts`                     | Dry-run post surface; live refuses missing native |
| `hostSnapshot.ts` / `interferenceDiff.ts` | Pure measurement                                  |
| `runScenario.ts`                          | Observe → act (dry) → re-observe                  |
| `fixtures/sample-apps.json`               | Offline catalog                                   |
| `*.test.ts`                               | Focused unit tests                                |

Companion harness CLI: `scripts/appdrive-interference/`.

## Tests

```bash
npx vitest run prototypes/appdrive-background
```

## Candidate recommendation

- Keep this tree as the **only** place to experiment with targeted background input.
- Do **not** productize `CGEventPostToPid` until the interference harness produces
  live `nonInterferenceProven: true` for an allowlisted app set under user consent.
- Ship Foreground Drive UI/session productization separately (other work lanes).
