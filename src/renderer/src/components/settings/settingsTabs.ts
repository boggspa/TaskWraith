/**
 * Settings tab registry — extracted from `../SettingsPanel.tsx`
 * (behavior-preserving move; `SettingsPanel.tsx` re-exports the public
 * surface so `SettingsSidebar`, views, and tests keep working).
 */
import { IOS_REMOTE_ENABLED } from '../../lib/featureFlags'

export type SettingsTab =
  | 'appearance'
  | 'behavior'
  | 'about'
  | 'providers'
  | 'roster'
  | 'agent-pool'
  | 'mcp'
  | 'mcp-servers'
  | 'runtime-profiles'
  | 'plugins'
  | 'instructions'
  | 'skills'
  | 'hooks'
  | 'key-commands'
  | 'approval-ledger'
  | 'thread-introspection'
  | 'safety-privacy'
  | 'pairing'
  | 'channels'
  | 'workspaces'
  | 'pinned-messages'
  | 'archived'
  | 'model-usage'
  | 'local-servers'
  | 'notification-banners'

/**
 * Tab grouping discriminator. The settings sidebar renders user-facing
 * group labels so the takeover scales beyond a flat list while the
 * underlying tab ids remain stable for persisted state.
 */
export type SettingsTabGroup =
  | 'app'
  | 'ai-providers'
  | 'automation'
  | 'workspaces'
  | 'integrations'
  | 'data'

export const SETTINGS_TAB_GROUP_LABELS: Record<SettingsTabGroup, string> = {
  app: 'App',
  'ai-providers': 'AI & Providers',
  automation: 'Automation',
  workspaces: 'Workspaces',
  integrations: 'Integrations',
  data: 'Data'
}

export type SettingsScope = 'global' | 'provider' | 'workspace' | 'device'

export interface SettingsTabDefinition {
  id: SettingsTab
  label: string
  group: SettingsTabGroup
  description: string
  aliases: string[]
  scope: SettingsScope
}

/**
 * Canonical settings-tab list. Exported so `SettingsSidebar` (used in
 * full-app takeover layout) can render the same list of tabs as the
 * inline tab bar inside this panel — keeping both render sites in
 * lockstep when tabs are added / renamed.
 *
 * Order matters: the sidebar renders tabs in this order and inserts
 * a divider whenever the `group` field changes from the previous
 * tab. The TestFlight-gated Devices tab remains last in the canonical
 * list, but `getVisibleSettingsTabs` hides it while the iOS remote
 * feature flag is off.
 */
export const SETTINGS_TABS: SettingsTabDefinition[] = [
  {
    id: 'behavior',
    label: 'General',
    group: 'app',
    description: 'Core app behavior, dashboard defaults, approval timeouts, and maintenance.',
    aliases: ['behavior', 'system', 'timeouts', 'currency', 'dashboard', 'desktop'],
    scope: 'global'
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'app',
    description:
      'Themes, composer shells, fonts, density, motion, transparency, and visual effects.',
    aliases: ['theme', 'font', 'motion', 'transparency', 'density', 'accessibility', 'composer'],
    scope: 'global'
  },
  {
    id: 'key-commands',
    label: 'Keyboard shortcuts',
    group: 'app',
    description: 'Editable app keybindings and command shortcuts.',
    aliases: ['key commands', 'hotkeys', 'keybindings', 'commands', 'record shortcut'],
    scope: 'global'
  },
  {
    id: 'about',
    label: 'About & Licenses',
    group: 'app',
    description:
      'TaskWraith licensing, exact packaged dependency notices, and Chromium attribution.',
    aliases: [
      'about',
      'license',
      'licenses',
      'attribution',
      'third party',
      'source code',
      'Apache-2.0',
      'chromium'
    ],
    scope: 'global'
  },
  {
    id: 'providers',
    label: 'Providers',
    group: 'ai-providers',
    description: 'Provider sign-in, runtime health, CLI/API setup, and agentic service policies.',
    aliases: [
      'models',
      'auth',
      'login',
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'ollama',
      'gemini'
    ],
    scope: 'provider'
  },
  {
    id: 'roster',
    label: 'Ensemble roster',
    group: 'ai-providers',
    description:
      'Saved Ensemble participant presets, roles, provider chains, and orchestration defaults.',
    aliases: ['roster', 'ensemble', 'participants', 'roles', 'multi-provider', 'panel'],
    scope: 'provider'
  },
  {
    id: 'agent-pool',
    label: 'Agent pool',
    group: 'ai-providers',
    description:
      'Reusable Agents — provider, model, role, icon and hue — you can add to any Ensemble preset.',
    aliases: ['agent pool', 'agents', 'pool', 'reusable agents', 'icon', 'hue', 'nickname'],
    scope: 'provider'
  },
  {
    id: 'approval-ledger',
    label: 'Approvals & Grants',
    group: 'automation',
    description: 'Approval history, durable audit entries, and saved workspace grants.',
    aliases: ['approvals', 'audit', 'ledger', 'grants', 'permissions', 'risk', 'safety'],
    scope: 'workspace'
  },
  {
    id: 'thread-introspection',
    label: 'Thread introspection',
    group: 'automation',
    description:
      'Review distilled lessons from recent runs before promoting preferences, conventions, or skill updates.',
    aliases: [
      'introspection',
      'memory promotion',
      'memory proposals',
      'retrospective',
      'agent memory',
      'skill distillation',
      'daily introspection'
    ],
    scope: 'workspace'
  },
  {
    id: 'workspaces',
    label: 'Workspaces',
    group: 'workspaces',
    description:
      'Registered workspaces, launch targets, pinning, removal, and paired-device access shortcuts.',
    aliases: ['projects', 'folders', 'environments', 'remote access', 'workspace list'],
    scope: 'workspace'
  },
  {
    id: 'mcp',
    label: 'Provider Tools',
    group: 'integrations',
    description:
      'TaskWraith MCP bridge status, built-in tool catalog, provider surfaces, and policy audit.',
    aliases: [
      'provider tools',
      'taskwraith tools',
      'tools',
      'tools mcp',
      'tools and mcps',
      'tool audit',
      'bridge',
      'mcp bridge'
    ],
    scope: 'provider'
  },
  {
    id: 'mcp-servers',
    label: 'MCP Servers',
    group: 'integrations',
    description:
      'User-managed MCP server definitions, enablement, transport, commands, URLs, and env vars.',
    aliases: [
      'mcp',
      'servers',
      'mcp servers',
      'custom mcp',
      'external tools',
      'connectors',
      'codex mcp',
      'codex toml',
      'claude mcp',
      'claude json',
      'cursor mcp',
      'cursor json',
      'cursor mcp.json',
      'cursor mcp json',
      'mcp json',
      'mcp.json',
      'model context protocol',
      'claude desktop',
      'claude desktop config',
      'claude_desktop_config.json',
      'cursor config',
      'codex config',
      'codex config toml',
      'connect mcp',
      'manage mcp',
      'stdio mcp',
      'http mcp',
      'streamable http',
      'sse server',
      'user mcp',
      'user-managed mcp',
      'toml',
      'import mcp',
      'import json'
    ],
    scope: 'global'
  },
  {
    id: 'runtime-profiles',
    label: 'Runtime profiles',
    group: 'integrations',
    description: 'Provider runtime profiles, binary overrides, env vars, and encrypted env refs.',
    aliases: [
      'runtime',
      'runtime profiles',
      'profiles',
      'binary path',
      'environment',
      'encrypted environment',
      'secret env',
      'provider runtime'
    ],
    scope: 'provider'
  },
  {
    id: 'plugins',
    label: 'Plugins',
    group: 'integrations',
    description:
      'Declarative capability bundles, installed state, marketplace metadata, and preflight status.',
    aliases: [
      'plugins',
      'extensions',
      'connectors',
      'marketplace',
      'installed',
      'bundles',
      'capability bundles'
    ],
    scope: 'global'
  },
  {
    id: 'instructions',
    label: 'Custom Instructions',
    group: 'integrations',
    description:
      'Standing prompt preferences: the global instructions document and the workspace TASKWRAITH.md layer.',
    aliases: [
      'custom instructions',
      'instructions',
      'taskwraith.md',
      'system prompt',
      'prompt layers',
      'global instructions',
      'workspace instructions'
    ],
    scope: 'workspace'
  },
  {
    id: 'skills',
    label: 'Skills',
    group: 'integrations',
    description:
      'User and workspace skill libraries — enablement, create, delete, and Finder roots.',
    aliases: [
      'skills',
      'skill library',
      'skill.md',
      'agent skills',
      'workspace skills',
      'user skills'
    ],
    scope: 'workspace'
  },
  {
    id: 'hooks',
    label: 'Hooks',
    group: 'integrations',
    description:
      'Host-mediated shell hooks for SessionStart, PreToolUse, PostToolUse, and Stop lifecycle events.',
    aliases: [
      'hooks',
      'shell hooks',
      'session start',
      'pre tool use',
      'post tool use',
      'stop hook',
      'lifecycle hooks'
    ],
    scope: 'workspace'
  },
  {
    id: 'local-servers',
    label: 'Local servers',
    group: 'integrations',
    description:
      'Dev servers and watchers running under workspaces, with stop and lifecycle controls.',
    aliases: ['localhost', 'ports', 'preview', 'vite', 'next', 'watchers', 'browser'],
    scope: 'workspace'
  },
  {
    id: 'pairing',
    label: 'Devices',
    group: 'integrations',
    description: 'iPhone and iPad pairing, Tailscale, bridge networking, and push wake.',
    aliases: [
      'ios',
      'iphone',
      'ipad',
      'remote',
      'pairing',
      'tailscale',
      'apns',
      'mobile',
      'bridge'
    ],
    scope: 'device'
  },
  {
    id: 'channels',
    label: 'Channels',
    group: 'integrations',
    description:
      'Chats you share as channels — members, access, per-channel close, and the audit log.',
    aliases: [
      'channel',
      'channels',
      'share',
      'shares',
      'shared chats',
      'collaborators',
      'people',
      'collaboration',
      'invite'
    ],
    scope: 'global'
  },
  {
    id: 'safety-privacy',
    label: 'Safety & Privacy',
    group: 'data',
    description:
      'Risk posture, local history, provider data flow, mobile visibility, and grant status.',
    aliases: [
      'privacy',
      'safety',
      'security',
      'risk',
      'data',
      'history',
      'grants',
      'permissions',
      'mobile visibility',
      'screen watch',
      'canvas'
    ],
    scope: 'global'
  },
  {
    id: 'notification-banners',
    label: 'Notification banners',
    group: 'data',
    description: 'Wording of run-complete notifications on paired iPhone and iPad.',
    aliases: ['notifications', 'banners', 'push', 'apns', 'ios', 'iphone', 'ipad', 'alerts'],
    scope: 'global'
  },
  {
    id: 'pinned-messages',
    label: 'Pinned messages',
    group: 'data',
    description: 'Pinned transcript snippets and saved context across chats.',
    aliases: ['pins', 'messages', 'saved context', 'notes'],
    scope: 'global'
  },
  {
    id: 'archived',
    label: 'Archived',
    group: 'data',
    description: 'Restore, permanently delete, or export archived conversation threads.',
    aliases: ['archive', 'archived', 'history', 'restore', 'unarchive', 'export threads'],
    scope: 'global'
  },
  {
    id: 'model-usage',
    label: 'Model usage',
    group: 'data',
    description: 'Cross-provider quota, token, usage, cost, and context snapshots.',
    aliases: [
      'usage',
      'quota',
      'tokens',
      'cost',
      'credits',
      'billing',
      'context',
      'rates',
      'pricing',
      'api cost'
    ],
    scope: 'provider'
  }
]

const FEATURE_GATED_SETTINGS_TABS = new Set<SettingsTab>([
  // Banner wording is meaningless without a paired device to render it, so it
  // hides on the same signal as pairing itself.
  ...(IOS_REMOTE_ENABLED ? [] : (['pairing', 'notification-banners'] as SettingsTab[]))
])

export function isSettingsTabVisible(tab: SettingsTab): boolean {
  return !FEATURE_GATED_SETTINGS_TABS.has(tab)
}

export function getVisibleSettingsTabs(): SettingsTabDefinition[] {
  return SETTINGS_TABS.filter((tab) => isSettingsTabVisible(tab.id))
}

export function resolveVisibleSettingsTab(tab: SettingsTab): SettingsTab {
  return isSettingsTabVisible(tab) ? tab : 'behavior'
}

export function settingsTabMatchesQuery(tab: SettingsTabDefinition, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystack = [
    tab.label,
    tab.id,
    tab.description,
    tab.scope,
    SETTINGS_TAB_GROUP_LABELS[tab.group],
    ...tab.aliases
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}
