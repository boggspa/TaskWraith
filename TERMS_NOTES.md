# Legal and Privacy Boundaries

- TaskWraith is a public-source, local-first desktop application with an
  optional paired iOS companion and relay transport.
- TaskWraith is not affiliated with, endorsed by, or sponsored by any supported AI
  provider, CLI vendor, or platform vendor.
- Provider names are used only to identify compatible integrations and user
  configuration paths.
- A narrowly scoped set of first-party provider PNG marks is committed for
  factual provider identification. The source and rights notes are recorded in
  `design-assets/provider-logos/`; the marks remain their owners' property and
  do not imply endorsement. Proprietary provider fonts, credentials, signing
  identities, notarization profiles, and private release artifacts should not
  be committed to the public repository.
- TaskWraith does not scrape provider web properties, bypass authentication,
  bypass quotas, bypass rate limits, or grant itself provider account access.
- Users are responsible for complying with the terms that apply to the provider
  CLIs, SDKs, APIs, accounts, and models they choose to use.
- Runtime history, workspace state, approval ledgers, usage records, pairing
  state, and APNs token routing data are stored locally under the desktop app's
  OS app-data directory by default. The iOS companion sends encrypted task projections and
  actions through the relay; relay/APNs infrastructure may see routing metadata
  such as pair, device, thread/run, reason, timestamps, and aggregate
  added/deleted line counts, but not plaintext prompts, commands, diff contents
  or hunks, file contents, or model output.
- Files, images, Discord context, prompts, and tool output sent to a selected
  provider runtime are governed by that provider, account, model, and CLI/API
  terms.
- While transcript sky visual FX are enabled, TaskWraith automatically requests
  approximate location from `ipapi.co`, falling back to `ipwho.is`; those
  services can see the host's public IP. It rounds the returned coordinates to
  0.1° (about 11 km) before requesting current conditions from Open-Meteo,
  which receives those rounded coordinates and the request's source IP. This
  flow does not send task, transcript, file, or workspace content, and the last
  coarse location and weather snapshot are cached locally in
  `host-weather-cache.json`.
- The sky/weather data path is a third-party collection feature and should be
  included in the privacy, security, and App Store disclosure review for any
  release that enables it.
- Any future hosted sync, plaintext backend, project-operated push gateway, or
  third-party collection feature should receive a fresh privacy, security, and
  App Store disclosure review before release.
