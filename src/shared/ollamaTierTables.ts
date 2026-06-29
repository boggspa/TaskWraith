/**
 * Shared Ollama tier + run-profile label tables.
 *
 * Single source of truth for the human-facing tool-control tier ladder and the
 * run-profile presets, shared by Settings → Behavior → Ollama AND the composer's
 * per-chat tier picker (OllamaTierPicker). Pure data + type-only imports — no
 * node builtins — so it is safe to import from the renderer bundle (see
 * MEMORY.md on the renderer blank-window hazard).
 *
 * MODEL REALITY: `OllamaToolControlTier` is ONE cumulative 4-step ladder
 * (read_only = Tier 1 … provider_parity = Tier 4 / "parity"). Run profiles keep
 * their minimum tier metadata, but the picker can present them alongside the
 * selected tool grants when a participant needs a more specific local runtime.
 */
import type { OllamaRunProfileId, OllamaToolControlTier } from '../main/store/types'

export interface OllamaToolControlTierOption {
  value: OllamaToolControlTier
  label: string
  helper: string
}

export interface OllamaRunProfileOption {
  value: OllamaRunProfileId
  label: string
  tier: OllamaToolControlTier
  helper: string
}

export const OLLAMA_TOOL_CONTROL_TIERS: OllamaToolControlTierOption[] = [
  {
    value: 'read_only',
    label: 'Tier 1 · Read-only',
    helper: 'Workspace listing, file reads, and search only.'
  },
  {
    value: 'approved_edits',
    label: 'Tier 2 · Approved edits',
    helper: 'write_file, replace, and apply_patch with intent plus modal approval.'
  },
  {
    value: 'approved_shell',
    label: 'Tier 3 · Approved shell',
    helper: 'Adds shell commands. Every command still requires modal approval.'
  },
  {
    value: 'provider_parity',
    label: 'Tier 4 · Provider parity',
    helper: 'Full TaskWraith tool surface after explicit risk acknowledgement.'
  }
]

export const OLLAMA_RUN_PROFILE_OPTIONS: OllamaRunProfileOption[] = [
  {
    value: 'local_scout',
    label: 'Local Scout',
    tier: 'read_only',
    helper: 'Read/search/symbol/git inspection with a moderate local reasoning budget.'
  },
  {
    value: 'approved_patcher',
    label: 'Approved Patcher',
    tier: 'approved_edits',
    helper: 'Bounded file edits with approval and a higher local reasoning budget.'
  },
  {
    value: 'verify_with_shell',
    label: 'Verify With Shell',
    tier: 'approved_shell',
    helper: 'Adds approved task/shell verification for scoped patches.'
  },
  {
    value: 'provider_parity',
    label: 'Provider Parity',
    tier: 'provider_parity',
    helper: 'Full TaskWraith tool surface after workspace acknowledgement.'
  }
]
