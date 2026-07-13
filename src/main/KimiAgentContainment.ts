/**
 * Kimi Wire approvals do not include structured native-tool arguments, so the
 * host cannot bind those calls to TaskWraith's signed workspace/path grants.
 * Launch Kimi with this agent specification to expose no built-in tools. Kimi
 * loads configured MCP servers after the built-in tool list, so the explicitly
 * namespaced TaskWraith broker remains available.
 */
export const KIMI_BROKER_ONLY_AGENT_YAML = `version: 1
agent:
  extend: default
  allowed_tools: []
  subagents: {}
`

export function buildKimiBrokerOnlyAgentYaml(): string {
  return KIMI_BROKER_ONLY_AGENT_YAML
}
