# Import an external provider thread

TaskWraith can import a user-selected Codex, Claude, Cursor, or AntiGravity
transcript as a local archived snapshot.

## Import a file

1. Open **Settings → Archived**.
2. Under **Import an external provider thread**, choose the source provider.
3. Click **Choose transcript file…** and select one `.jsonl` or `.json` file.
4. Inspect the imported row in Archived Threads. Unarchive it only when you
   want it visible in the main sidebar.

Local chat history must be enabled so the imported archive can be persisted.

TaskWraith never scans or watches provider home directories. The picker accepts
one file per user gesture; there is no startup discovery or account connection.
Typical source files live under provider-owned folders such as Codex sessions,
Claude projects, Cursor agent transcripts, or an AntiGravity brain transcript,
but their absolute path is never stored in the imported chat.

## Trust and continuity

An import is a display snapshot, not a resumed provider thread:

- imported user and assistant rows carry `external_untrusted` provenance;
- tool calls, tool results, system rows, attachments and private reasoning are
  omitted;
- imported rows are excluded from solo, Gemini and Ensemble prompt history;
- no provider thread/session id, credential, fork receipt or native continuity
  field is created; the persistence fence strips those fields again on every
  later save, so an unarchived import always starts provider turns fresh;
- the chat keeps TaskWraith's current runnable provider. The source provider is
  provenance only;
- identical provider/file bytes deduplicate to the existing imported chat.

The persistent banner on an imported transcript repeats this boundary. To
bridge selected text deliberately, use the existing **Add to prompt** or copy
action, review the resulting composer text, and press Send. That creates a new
host-authored message; V1 never bridges imported text automatically.

## Bounds

One source file is limited to 16 MB. The importer retains at most 2,000 messages,
100,000 characters per message, and 4 MB of transcript text. It records source,
imported, omitted and malformed-row counts plus whether a cap truncated the
snapshot. TaskWraith-owned Codex rollouts, Cursor subagents and TaskWraith
sandbox transcripts are rejected instead of being duplicated.
