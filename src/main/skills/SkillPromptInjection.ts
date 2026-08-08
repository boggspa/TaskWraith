/**
 * Progressive skill discovery for prompt composition.
 *
 * Wave A2 exposes enabled skills as a compact name + one-line description
 * block. Full skill bodies stay behind `skill_list` / `skill_read` MCP tools
 * so every turn does not pay the full library cost.
 *
 * Integration (later, one-line): append `buildSkillDiscoveryBlock(skills)` into
 * PromptComposition sections when non-null. Do not wire that here yet.
 */

export interface SkillDiscoveryEntry {
  id: string
  name: string
  description: string
}

/** Max skills listed in the discovery block (remainder summarized). */
export const MAX_SKILL_DISCOVERY_LIST = 24

/** Max chars kept for each skill description line. */
export const MAX_SKILL_DISCOVERY_DESCRIPTION_CHARS = 160

const DISCOVERY_HEADER = '## Available skills'
const DISCOVERY_INSTRUCTIONS = [
  'These TaskWraith skills are enabled for this workspace.',
  'Use the `skill_list` MCP tool for the catalog and `skill_read` with a skill id for the full body.',
  'Do not invent skill contents — fetch them when needed.'
].join(' ')

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Build a compact progressive-disclosure prompt block for enabled skills.
 * Returns null when there are no skills to advertise.
 */
export function buildSkillDiscoveryBlock(skills: readonly SkillDiscoveryEntry[]): string | null {
  const entries = (skills ?? [])
    .map((skill) => ({
      id: (skill.id || '').trim(),
      name: (skill.name || '').trim() || (skill.id || '').trim(),
      description: oneLine(skill.description || '', MAX_SKILL_DISCOVERY_DESCRIPTION_CHARS)
    }))
    .filter((skill) => skill.id)

  if (entries.length === 0) return null

  const listed = entries.slice(0, MAX_SKILL_DISCOVERY_LIST)
  const omitted = entries.length - listed.length
  const lines = listed.map((skill) => {
    const label = skill.description
      ? `- ${skill.name} (\`${skill.id}\`): ${skill.description}`
      : `- ${skill.name} (\`${skill.id}\`)`
    return label
  })

  if (omitted > 0) {
    lines.push(`- …and ${omitted} more (call \`skill_list\` for the full enabled catalog).`)
  }

  return [DISCOVERY_HEADER, '', DISCOVERY_INSTRUCTIONS, '', ...lines].join('\n')
}
