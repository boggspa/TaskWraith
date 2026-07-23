# AntiGravity combined-mode threat model and migration contract

This contract applies to the opt-in `antigravity` provider's separately
labelled Gemini API mode. It describes the source-ahead implementation at
`73f08b535`; it is a certification contract, not a new provider or a request to
remove or disable an existing user capability.

## Scope and assets

The mode has two intentionally separate lanes under the existing
`antigravity` provider:

- The official user-installed `agy` transport owns AntiGravity subscription
  models and AntiGravity quota.
- The Gemini API lane uses only an explicitly entered project API key and the
  official `@google/genai` SDK against its public API. Its models are
  namespaced as `gemini-api:gemini-*`, labelled Gemini API / separate billing,
  and are not AntiGravity Claude/GPT models or subscription quota.

Assets include the user-entered API key, the nonsecret disclosure timestamp,
authenticated model ids and labels, usage/rate-limit state, and the paired
device catalog. The key is the sensitive asset; model rows, statuses, labels,
timestamps, and fixed failure categories are nonsecret projections.

## Trust boundaries and transport

The key crosses only the main-renderer IPC bridge after its input boundary
checks. It is held transiently by the renderer password control and is cleared
in `finally`; the renderer and paired iOS device never receive the key or
ciphertext. Main constructs the dedicated, purpose-bound
`AntigravityGeminiApiSecretStore` after Electron is ready. The store uses
platform encryption plus an atomic owner-only record and fails closed when
`safeStorage` is unavailable or its backend is unsafe (including Linux
`basic_text`/unknown backends).

The Gemini API lane uses the official `@google/genai` SDK and its public API
surface only. It must not read or reuse OAuth, keyring, official `agy`,
AntiGravity, retired Gemini, Vertex, legacy Gemini-profile, environment, or
argv credentials, and must not call private endpoints. Discovery and turns use
bounded requests, exact namespaced model validation, abort handling, and fixed
nonsecret failure statuses; raw SDK errors, keys, sentinels, and endpoint data
do not cross a projection boundary.

## Upgrade, set, clear, and rollback semantics

An existing installation upgrades with no migration of credentials or legacy
Gemini state. Missing AntiGravity consent, missing Gemini disclosure, and a
missing dedicated key are represented by absent/null/unconfigured state and
fail closed. The static selectable-provider set is unchanged: `antigravity`
and retired `gemini` are not added to it.

The separate disclosure is accepted only by an explicit user action and stores
only a bounded nonsecret timestamp. A successful key set or clear starts a new
configured-provider discovery generation before broadcasting pending-empty
catalog state to paired devices, withdrawing stale rows immediately. A
successful set leaves the new key available only to the dedicated store; a
successful clear removes that record and the next generation cannot discover
Gemini API rows. Failed set/clear operations do not emit the success
invalidation path and preserve the previous usable state. If discovery,
encryption, or transport fails, the affected lane returns a fixed empty or
unavailable result; the AGY lane remains independent. Restart, rollback, or a
downgrade therefore cannot silently resurrect a legacy credential or stale API
admission.

## Billing, data use, and quota

The UI must state that this is Gemini-only, separately metered/billed, subject
to project limits, and does not consume AntiGravity subscription quota or
expose AntiGravity Claude/GPT models. Free-versus-Paid Google data-use terms
are disclosed, including that Free-tier content may be used to improve Google
products while Paid Services content is not; TaskWraith cannot infer the
project's tier and must not promise one. Gemini API usage and rate-limit state
are isolated from `agy`; the AntiGravity quota path is eligible only when an
authenticated AGY catalog row exists. An API-only catalog must not probe the
authenticated AGY resolver or PTY quota path.

## Electron and paired-iOS projection

Electron owns the key, discovery, admission, and catalog generation. Renderer
state receives only allowlisted status, fixed errors, disclosure state, and
nonsecret model rows. Paired iOS receives the dynamic `antigravity` catalog
through the existing provider-models broadcast. A valid row such as
`gemini-api:gemini-2.5-flash` decodes as an AntiGravity catalog row and may
admit AntiGravity dynamically, while `TWTheme.liveSelectableProviderIds`
remains unchanged and `gemini` remains retired/unavailable for new runs.

## Invariants and review evidence

Preserve default-off informed AntiGravity consent and its account/ToS/ban-risk
warning, First Launch silence, live-list silence, and marketing silence. Any
future change must preserve the dedicated secret-store boundary, official SDK
transport, no-credential-reuse rule, lane/quota isolation, pending-broadcast
ordering, exact `gemini-api:gemini-*` namespace, and static live-set parity.
The source regression suites cover successful set and clear ordering, dynamic
paired-iOS wire decoding/admission, and the unchanged retired/static provider
boundaries.
