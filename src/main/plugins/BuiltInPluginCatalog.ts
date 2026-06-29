import type { TaskWraithPluginManifest } from './PluginManifest'

export const BUILT_IN_TASKWRAITH_PLUGIN_MANIFESTS: TaskWraithPluginManifest[] = [
  {
    schemaVersion: 1,
    id: 'github-dev-bundle',
    publisher: 'taskwraith',
    name: 'GitHub Dev Bundle',
    version: '1.0.0',
    description:
      'GitHub-oriented MCP preset metadata, review workflows, and approval posture notes for repository work.',
    capabilities: [
      {
        kind: 'mcpServers',
        id: 'github-mcp-preset',
        label: 'GitHub MCP preset',
        description: 'Declarative stdio MCP preset that can be installed into user MCP servers later.',
        risk: 'high',
        agenticServices: ['mcpTools'],
        networkScopes: ['public-web']
      },
      {
        kind: 'workflowTemplates',
        id: 'pr-review-workflows',
        label: 'Pull request workflows',
        description: 'Review, CI triage, and release-note workflow templates.',
        risk: 'medium',
        agenticServices: ['mcpTools', 'fileChanges']
      }
    ],
    permissions: {
      agenticServices: {
        mcpTools: 'ask',
        fileChanges: 'ask'
      },
      networkScopes: ['public-web']
    },
    secrets: [
      {
        id: 'github-token',
        label: 'GitHub token',
        envVar: 'GITHUB_TOKEN',
        required: false,
        description: 'Optional environment variable used by GitHub MCP servers.'
      }
    ],
    mcpServers: [
      {
        id: 'github-stdio',
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}'
        },
        enabledByDefault: false,
        requiredSecrets: ['github-token'],
        description: 'GitHub MCP stdio preset. Stdio presets must be installed explicitly.'
      }
    ],
    workflowTemplates: [
      {
        id: 'summarise-pr-feedback',
        name: 'Summarise PR feedback',
        prompt: 'Summarise unresolved review comments, failing checks, and the smallest safe patch plan.',
        provider: 'codex',
        approvalMode: 'plan',
        requiredTools: ['git_status', 'git_diff']
      }
    ],
    marketplace: {
      category: 'Development',
      tags: ['github', 'git', 'pull requests', 'ci'],
      displayName: 'GitHub Dev Bundle'
    }
  },
  {
    schemaVersion: 1,
    id: 'ios-remote-bundle',
    publisher: 'taskwraith',
    name: 'iOS Remote Bundle',
    version: '1.0.0',
    description:
      'Remote projection metadata and setup checks for safe iPhone and iPad TaskWraith control.',
    compatibility: {
      platforms: ['darwin']
    },
    capabilities: [
      {
        kind: 'mobileRemoteProjection',
        id: 'ios-remote-projection',
        label: 'iOS remote projection',
        description: 'Remote workspace start-turn, status, approval, and cancel affordance metadata.',
        risk: 'medium',
        remoteCapabilities: ['startTurn', 'viewStatus', 'approve', 'cancelRun']
      }
    ],
    permissions: {
      remoteCapabilities: ['startTurn', 'viewStatus', 'approve', 'cancelRun'],
      networkScopes: ['localhost', 'configured-origin']
    },
    mobileRemoteProjection: [
      {
        id: 'ios-safe-remote',
        label: 'Safe iOS remote controls',
        remoteCapabilities: ['startTurn', 'viewStatus', 'approve', 'cancelRun'],
        description: 'Metadata for bridge allowlist cards and paired-device setup checks.'
      }
    ],
    marketplace: {
      category: 'Remote',
      tags: ['ios', 'ipad', 'remote', 'bridge', 'tailscale'],
      displayName: 'iOS Remote Bundle'
    }
  },
  {
    schemaVersion: 1,
    id: 'web-qa-bundle',
    publisher: 'taskwraith',
    name: 'Web QA Bundle',
    version: '1.0.0',
    description:
      'Browser, canvas, screenshot, local server, and console workflows for web application QA.',
    capabilities: [
      {
        kind: 'taskwraithToolBundle',
        id: 'web-qa-tools',
        label: 'Web QA tools',
        description: 'Browser and canvas inspection tools for local web app verification.',
        risk: 'medium',
        agenticServices: ['mcpTools', 'canvasInteraction'],
        networkScopes: ['localhost']
      },
      {
        kind: 'localServices',
        id: 'local-dev-server-checks',
        label: 'Local dev server checks',
        description: 'Localhost service metadata for Vite, Next, and similar dev servers.',
        risk: 'low',
        networkScopes: ['localhost']
      }
    ],
    permissions: {
      agenticServices: {
        mcpTools: 'ask',
        canvasInteraction: 'ask'
      },
      networkScopes: ['localhost']
    },
    taskwraithToolBundles: [
      {
        id: 'browser-and-canvas',
        label: 'Browser and Canvas QA',
        description: 'Open, inspect, screenshot, and interact with local web previews.',
        tools: [
          'browser_open',
          'browser_screenshot',
          'browser_console',
          'canvas_open',
          'canvas_snapshot',
          'canvas_screenshot',
          'canvas_console',
          'canvas_click',
          'canvas_fill',
          'canvas_close'
        ]
      }
    ],
    localServices: [
      {
        id: 'localhost-web-app',
        label: 'Local web app',
        description: 'A workspace dev server exposed on localhost.',
        ports: [3000, 5173, 8080],
        healthCheck: {
          url: 'http://127.0.0.1:<port>/'
        },
        managedByTaskWraith: false
      }
    ],
    workflowTemplates: [
      {
        id: 'responsive-smoke-test',
        name: 'Responsive smoke test',
        prompt:
          'Open the local web app, capture desktop and mobile screenshots, inspect console errors, and report blocking UI defects.',
        provider: 'codex',
        approvalMode: 'default',
        requiredTools: ['browser_open', 'browser_screenshot', 'browser_console']
      }
    ],
    marketplace: {
      category: 'Quality',
      tags: ['web', 'qa', 'browser', 'screenshots', 'localhost'],
      displayName: 'Web QA Bundle'
    }
  },
  {
    schemaVersion: 1,
    id: 'design-tools-bundle',
    publisher: 'taskwraith',
    name: 'Design Tools Bundle',
    version: '1.0.0',
    description:
      'Connector metadata and guarded media tools for design review and asset preparation workflows.',
    capabilities: [
      {
        kind: 'connectors',
        id: 'design-connectors',
        label: 'Design connector metadata',
        description: 'Figma and Canva-style connector bindings for future marketplace setup.',
        risk: 'medium',
        networkScopes: ['configured-origin']
      },
      {
        kind: 'taskwraithToolBundle',
        id: 'guarded-media-tools',
        label: 'Guarded media tools',
        description: 'Image editing and SVG rasterization tools already owned by TaskWraith.',
        risk: 'medium',
        agenticServices: ['fileChanges']
      }
    ],
    permissions: {
      agenticServices: {
        fileChanges: 'ask'
      },
      networkScopes: ['configured-origin']
    },
    connectors: [
      {
        id: 'figma-like-design-api',
        label: 'Design API connector',
        kind: 'api-key',
        description: 'Metadata placeholder for a design-platform API connector.',
        requiredSecrets: ['design-api-token'],
        networkScopes: ['configured-origin']
      }
    ],
    secrets: [
      {
        id: 'design-api-token',
        label: 'Design API token',
        envVar: 'DESIGN_API_TOKEN',
        required: false
      }
    ],
    taskwraithToolBundles: [
      {
        id: 'image-asset-tools',
        label: 'Image asset tools',
        tools: ['image_edit', 'svg_rasterize'],
        description: 'Edit images and rasterize SVGs with existing gated TaskWraith tools.'
      }
    ],
    marketplace: {
      category: 'Design',
      tags: ['design', 'figma', 'assets', 'image'],
      displayName: 'Design Tools Bundle'
    }
  },
  {
    schemaVersion: 1,
    id: 'provider-setup-bundle',
    publisher: 'taskwraith',
    name: 'Provider Setup Bundle',
    version: '1.0.0',
    description:
      'Provider setup metadata, runtime-profile hints, and preflight recipes for built-in providers.',
    capabilities: [
      {
        kind: 'providerSetup',
        id: 'provider-preflight-recipes',
        label: 'Provider setup recipes',
        description: 'Install, auth, and status guidance for existing provider adapters.',
        risk: 'low'
      },
      {
        kind: 'runtimeProfiles',
        id: 'safe-runtime-profile-presets',
        label: 'Runtime profile presets',
        description: 'Declarative runtime profile templates for existing providers.',
        risk: 'medium',
        agenticServices: ['shellCommands', 'fileChanges', 'mcpTools']
      }
    ],
    permissions: {
      agenticServices: {
        shellCommands: 'ask',
        fileChanges: 'ask',
        mcpTools: 'ask'
      }
    },
    providerSetup: [
      {
        provider: 'codex',
        label: 'Codex CLI',
        installHint: 'Install and authenticate Codex through the configured provider setup flow.',
        preflightChecks: ['binary', 'auth', 'mcp']
      },
      {
        provider: 'claude',
        label: 'Claude CLI',
        installHint: 'Install Claude Code and authenticate through the CLI or API-key settings.',
        preflightChecks: ['binary', 'auth', 'mcp']
      },
      {
        provider: 'kimi',
        label: 'Kimi CLI',
        installHint: 'Install Kimi CLI and configure TaskWraith provider credentials.',
        preflightChecks: ['binary', 'auth']
      },
      {
        provider: 'cursor',
        label: 'Cursor CLI',
        installHint: 'Use Cursor CLI login and TaskWraith-contained write mode for edits.',
        preflightChecks: ['binary', 'auth']
      },
      {
        provider: 'grok',
        label: 'Grok CLI',
        installHint: 'Use Grok CLI login and TaskWraith provider setup checks.',
        preflightChecks: ['binary', 'auth']
      },
      {
        provider: 'ollama',
        label: 'Ollama',
        installHint: 'Run the local Ollama service and select a model in provider settings.',
        preflightChecks: ['service', 'model']
      }
    ],
    runtimeProfiles: [
      {
        id: 'codex-approved-edits',
        name: 'Codex approved edits',
        provider: 'codex',
        scope: 'workspace',
        workspaceMode: 'local',
        approvalMode: 'default',
        networkPolicy: 'inherit',
        persistence: 'reusable',
        agenticServices: {
          shellCommands: 'ask',
          fileChanges: 'ask',
          mcpTools: 'ask'
        }
      }
    ],
    marketplace: {
      category: 'Providers',
      tags: ['providers', 'setup', 'preflight', 'runtime'],
      displayName: 'Provider Setup Bundle'
    }
  }
]

