## Papercuts & small bugs

Concrete UX/a11y/parity issues found in TaskWraith UI. Each entry names the surface, what's wrong, and a suggested fix.

---

### Electron app

1. **NotificationZone freezes `now` at mount** — `NotificationZone.tsx` uses `useState(() => Date.now())` once, so time-bounded notices never expire until remount. Tick `now` on an interval or read `Date.now()` when filtering active notices.

2. **FirstLaunchSheet still offers Gemini composer shell** — Provider cards filter retired Gemini via `isRetiredProvider`, but `ONBOARDING_COMPOSER_OPTIONS` still lists "Gemini shell". Filter retired provider shells from the onboarding picker.

3. **Host admission Reject button lacks `aria-label`** — `HostAdmissionBanner.tsx` Reject is text-only with `title`; screen readers get no context about revoking the share when codes don't match. Add a descriptive `aria-label`.

4. **Approval elevation risk checkbox not linked to label** — `ApprovalModeElevationSheet.tsx` wraps checkbox + text in `<label>` but the input has no `id`/`htmlFor`. Add matching ids for consistent AT activation.

5. **ErrorBoundary reload not fully accessible** — `ErrorBoundary.tsx` shows error `<pre>` and "Reload window" without `aria-describedby` linking them. Add `id` on the pre and `aria-label` on the button.

6. **Inspector & file-editor toggles missing `aria-pressed`** — `App.tsx` chat-corner toggles for inspector and file editor don't expose on/off state (unlike sky/ghost/changelog buttons). Add `aria-pressed` to match sibling controls.

7. **JoinSharedChatModal: backdrop disconnects, no Escape** — `JoinSharedChatModal.tsx` backdrop calls `leaveAndClose` immediately; no Escape handler or focus trap (unlike `WorkspaceRemoteAccessModal`). Add modal parity and confirm-before-leave in active steps.

8. **JoinSharedChatModal form labels not wired** — Join fields use visual `<label>` without `htmlFor`/`id` pairing. Wire labels to inputs for screen readers.

9. **IncomingPairingPrompt hardcodes "iPhone"** — `IncomingPairingPrompt.tsx` title always says "iPhone wants to pair" even on iPad; no Escape or focus trap. Use device-neutral copy and add modal dismissal parity.

10. **Multiview close buttons announce generic "Close pane"** — `MultiviewPaneGrid.tsx` close affordance has no chat/pane identity in `aria-label`. Pass pane title into `aria-label={`Close pane: ${title}`}`.

---

### iOS/Swift app

1. **Thread toolbar Roster & Inspector lack VoiceOver labels** — `ThreadDetailViews.swift` Files/Diffs pills have `.accessibilityLabel`; Roster and Inspector icon pills do not. Add labels + hints matching the Files/Diffs pattern.

2. **First launch sheet says "iPhone" on iPad** — `FirstLaunchSheetView.swift` shows "Welcome to TaskWraith on iPhone" when `horizontalSizeClass == .regular`. Use size-class- or device-aware copy.

3. **Composer queue button has no accessibility label** — `ComposerView.swift` Queue control (icon + text) lacks `.accessibilityLabel` explaining it queues behind an active run.

4. **Photos attachment picker lacks accessibility label** — `ComposerView.swift` `PhotosPicker` shows `photo.badge.plus` with no label; at attachment limit there's no explanation for VoiceOver. Add label, hint, and `accessibilityValue` when capped.

5. **Sidebar `GlassPillHeader` missing collapsed state** — `TWSharedViews.swift` section headers toggle expand/collapse but don't expose count or collapsed state to VoiceOver. Add combined label like "Active Runs, 3 items, collapsed".

6. **Pairing code field relies on placeholder only** — `PairingViews.swift` `TextField("Paste pairing code (JSON)", …)` has no `.accessibilityLabel`. Add explicit label + hint pointing to Mac Settings → Devices.

7. **ConnectionBanner reconnecting not announced** — `TWSharedViews.swift` shows ProgressView + "Reconnecting…" without live-region traits. Combine children and announce phase changes.

8. **Home rename sheet can flash empty** — `HomeListViews.swift` `.sheet { if let card = renameSheetCard { … } }` can present blank content on dismiss race. Bind with `.sheet(item:)` or `renameSheetCard != nil`.

9. **File editor / diff studio status not announced** — `FileEditorViews.swift` and `DiffStudioViews.swift` update status strings ("Loading files…", "Computing diff…") without accessibility notification on change. Expose status row label and announce errors.

10. **Active host row doesn't expose connection state** — `PairingViews.swift` host buttons show green dot + "Active" in subtitle but VoiceOver only reads the host name. Add `.accessibilityValue(isActive ? "Active" : "Inactive")`.