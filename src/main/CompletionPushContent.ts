/*
 * CompletionPushContent — the rich plaintext sealed into a run-complete APNs
 * push (see src/shared/e2ee/pushSeal.ts). The iOS Notification Service Extension
 * decrypts this JSON and renders it via the shared CompletionBannerRenderer, so
 * the BACKGROUND/closed-app notification matches the foreground rich banner.
 *
 * Only the genuinely-sensitive fields ride the (encrypted) blob. Routing IDs
 * (taskId/runId/threadId) and success-vs-failed (the `reason`) already travel as
 * plaintext payload fields, so they're NOT duplicated here — the NSE reads them
 * from the payload and combines them with this decrypted content.
 *
 * JSON contract (must match the Swift CompletionPushContent decoder): keys
 * `title`, `preview`, `filesChanged`, `additions`, `deletions`.
 *
 * FROZEN CONTRACT — the Swift decoder declares all five fields NON-OPTIONAL, so
 * its JSONDecoder throws (→ the NSE shows the generic banner) if ANY key is
 * missing or retyped. `buildCompletionPushPlaintext` below therefore ALWAYS
 * emits all five as bare string/integer values. Do NOT make a field conditional
 * (e.g. omit a zero count) or change a number to a string without updating the
 * Swift `CompletionPushContent` in lockstep — otherwise every rich push silently
 * degrades to "Task complete" with no error anywhere.
 */

export interface CompletionPushContent {
  /** Chat / agent name — the banner title source. */
  title: string
  /** Last-message preview — the banner body source. */
  preview: string
  filesChanged: number
  additions: number
  deletions: number
}

/** Title clipped to keep the sealed blob comfortably under the 4KB APNs ceiling
 * (the pusher also hard-asserts the post-seal size and drops the blob if a
 * pathological case still exceeds — see Http2ApnsPusher). */
const TITLE_MAX_CODEPOINTS = 80
const PREVIEW_MAX_CODEPOINTS = 240

function clip(value: string | null | undefined, max: number): string {
  const trimmed = (value ?? '').trim()
  const codepoints = Array.from(trimmed)
  if (codepoints.length <= max) return trimmed
  return codepoints.slice(0, max - 1).join('') + '…'
}

function nonNegInt(value: number | null | undefined): number {
  return Math.max(0, Math.floor(Number(value) || 0))
}

/** Build the UTF-8 JSON plaintext to seal. Clips + normalizes so the blob stays
 * small and the shape is stable across platforms. */
export function buildCompletionPushPlaintext(content: CompletionPushContent): Buffer {
  const normalized = {
    title: clip(content.title, TITLE_MAX_CODEPOINTS),
    preview: clip(content.preview, PREVIEW_MAX_CODEPOINTS),
    filesChanged: nonNegInt(content.filesChanged),
    additions: nonNegInt(content.additions),
    deletions: nonNegInt(content.deletions)
  }
  return Buffer.from(JSON.stringify(normalized), 'utf8')
}
