/**
 * Read the effective context window for one Kimi Code model alias from the
 * config that will be copied into the isolated ACP home. Managed Kimi Code
 * refreshes write the plan-dependent base value, while user-pinned values live
 * under `[models."<alias>".overrides]`; the override wins when present.
 *
 * This intentionally parses only model table headers and `max_context_size`.
 * Keeping the reader narrow avoids pulling credentials or unrelated config
 * into runtime state and is sufficient for the documented Kimi TOML shape.
 *
 * Host-safe: Node and shared modules only. Must not import src/main/**.
 */

type ModelSection = { alias: string; override: boolean }

function parseModelSection(line: string): ModelSection | null {
  const match = line.match(
    /^\s*\[\s*models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(\.overrides)?\s*\]\s*(?:#.*)?$/
  )
  if (!match) return null
  return {
    alias: match[1] || match[2] || match[3],
    override: Boolean(match[4])
  }
}

function parsePositiveTomlInteger(line: string): number | undefined {
  const match = line.match(/^\s*max_context_size\s*=\s*([0-9][0-9_]*)\s*(?:#.*)?$/)
  if (!match) return undefined
  const value = Number(match[1].replaceAll('_', ''))
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export function effectiveKimiModelContextWindow(
  configBody: string,
  modelAlias: string
): number | undefined {
  const target = modelAlias.trim()
  if (!target) return undefined

  let section: ModelSection | null = null
  let baseValue: number | undefined
  let overrideValue: number | undefined

  for (const line of configBody.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      section = parseModelSection(line)
      continue
    }
    if (section?.alias !== target) continue
    const value = parsePositiveTomlInteger(line)
    if (value === undefined) continue
    if (section.override) overrideValue = value
    else baseValue = value
  }

  return overrideValue ?? baseValue
}
