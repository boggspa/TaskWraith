'use strict'

const path = require('node:path')
const { ROOT, loadHelper } = require('./common.cjs')

const ROLES = ['solo', 'ensemble', 'mesh']
const LIFECYCLES = ['fresh', 'resume', 'retained']
const OBSERVABLES = {
  P1: 'native thread env matches the observing child; distinct child PIDs across seats',
  P2: 'child PID continuity after idle resume and unsubscribe during an observed in-flight turn',
  P3: 'thread override and broker-token matches in bounded native-state bytes; negative is inconclusive',
  P4: 'per-thread args tag observed in the child process argv',
  P5: 'native per-thread tools/schema fingerprints compared with observed MCP tools/list traffic',
  permission:
    'actual TaskWraith dry-run probe outcome, correlated to operator-supplied signed route',
  brokerRestart: 'operator restarts the real isolated broker; endpoint epoch must change',
  dualInstance: 'two distinct private homes contend through the canonical OAuth authority'
}
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'COMSPEC',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS'
]

function tomlEscapeString(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}
function formatTomlInlineStringTable(entries) {
  return Object.entries(entries)
    .map(([key, value]) => '"' + tomlEscapeString(key) + '" = "' + tomlEscapeString(value) + '"')
    .join(', ')
}
/** Parity-tested against the pure functions in CodexAppServerClient.ts. */
function buildCodexTaskWraithMcpArgs(config) {
  const result = []
  if (config.enabled) {
    result.push(
      '-c',
      'mcp_servers.TaskWraith.command="' + tomlEscapeString(config.bridgeBinaryPath) + '"',
      '-c',
      'mcp_servers.TaskWraith.args=[' +
        config.bridgeArgs.map((arg) => '"' + tomlEscapeString(arg) + '"').join(', ') +
        ']',
      '-c',
      'mcp_servers.TaskWraith.env={ TASKWRAITH_PARENT_PROVIDER = "' +
        tomlEscapeString(config.parentProvider) +
        '" }',
      '-c',
      'mcp_servers.TaskWraith.default_tools_approval_mode="approve"'
    )
  }
  for (const server of config.userMcpServers || []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.serverName)) continue
    const key = 'mcp_servers.' + server.serverName
    if (server.transport === 'http') {
      result.push('-c', key + '.url="' + tomlEscapeString(server.url) + '"')
      if (server.bearerTokenEnvVar)
        result.push(
          '-c',
          key + '.bearer_token_env_var="' + tomlEscapeString(server.bearerTokenEnvVar) + '"'
        )
      if (server.headers && Object.keys(server.headers).length)
        result.push(
          '-c',
          key + '.http_headers={ ' + formatTomlInlineStringTable(server.headers) + ' }'
        )
    } else if (server.transport === 'stdio') {
      result.push(
        '-c',
        key + '.command="' + tomlEscapeString(server.command) + '"',
        '-c',
        key +
          '.args=[' +
          server.args.map((arg) => '"' + tomlEscapeString(arg) + '"').join(', ') +
          ']'
      )
      if (server.env && Object.keys(server.env).length) {
        result.push(
          '-c',
          key +
            '.env={ ' +
            Object.entries(server.env)
              .map(([key, value]) => key + ' = "' + tomlEscapeString(value) + '"')
              .join(', ') +
            ' }'
        )
      }
    }
  }
  return result
}

function profiles() {
  const fence = loadHelper('src/main/mcp/McpSessionProfileFence.ts')
  const ids = [
    fence.TASKWRAITH_FRESH_SOLO_GATEWAY_MCP_PROFILE_ID,
    fence.TASKWRAITH_FRESH_GATEWAY_MCP_PROFILE_ID,
    fence.TASKWRAITH_FRESH_GATEWAY_MESH_MCP_PROFILE_ID
  ]
  return ids.map((id, index) => ({
    role: ROLES[index],
    id,
    flags: {
      safeSubset: false,
      planSubset: false,
      coreSubset: false,
      gatewaySubset: fence.isGatewayTaskWraithMcpProfile(id),
      soloSubset: fence.isSoloTaskWraithMcpProfile(id),
      portableEnsembleControl: fence.isPortableEnsembleControlMcpProfile(id),
      meshDirect: fence.isMeshCanvasDirectTaskWraithMcpProfile(id),
      meshTopologyDirect: fence.isMeshTopologyDirectTaskWraithMcpProfile(id),
      sketchDirect: fence.isSketchCanvasDirectTaskWraithMcpProfile(id),
      orchestrationDirect: fence.isGatewayV13DirectTaskWraithMcpProfile(id),
      permissionOpportunityDirect: fence.isPermissionOpportunityDirectTaskWraithMcpProfile(id),
      auditSubset: false
    }
  }))
}

function bridgeArgs(registration, endpoint, profile) {
  const route = loadHelper('src/main/mcp/McpBridgeRoute.ts')
  if (registration === 'route-env') return route.buildStaticMcpBridgeRegistrationArgv()
  const args = [
    route.MCP_BRIDGE_ENTRY_ARG,
    '--socket',
    endpoint.socketPath,
    '--token',
    endpoint.brokerToken,
    '--instance-epoch',
    endpoint.instanceEpoch,
    '--bridge-log-epoch',
    String(endpoint.bridgeLogEpoch)
  ]
  const switches = {
    safeSubset: '--safe-subset',
    planSubset: '--plan-subset',
    coreSubset: '--core-subset',
    gatewaySubset: '--gateway-subset',
    portableEnsembleControl: '--portable-ensemble-control',
    meshDirect: '--mesh-direct',
    meshTopologyDirect: '--mesh-topology-direct',
    sketchDirect: '--sketch-direct',
    orchestrationDirect: '--orchestration-direct',
    auditSubset: '--audit-subset',
    soloSubset: '--solo-subset',
    permissionOpportunityDirect: '--permission-opportunity-direct'
  }
  for (const [flag, value] of Object.entries(switches)) if (profile.flags[flag]) args.push(value)
  return args
}

function observerArgs(command, args, tag) {
  return [
    path.join(ROOT, 'scripts/codex-proof/proxy.cjs'),
    '--target-command',
    command,
    '--argv-tag',
    tag,
    ...args.flatMap((arg) => ['--target-arg', arg])
  ]
}

function routeEnvironment(manifest, role, lifecycle, profile) {
  const routes = manifest.routes || {}
  const selected = routes[role]?.[lifecycle] || routes[role]?.fresh
  const route = selected || {
    appRunId: 'proof-' + role + '-' + lifecycle,
    appChatId: 'proof-' + role
  }
  const helper = loadHelper('src/main/mcp/McpBridgeRoute.ts')
  const built = helper.buildMcpBridgeRouteEnv({
    route,
    parentProvider: 'codex',
    workspacePath: manifest.workspace,
    endpoint: manifest.endpoint,
    profile: profile.flags
  })
  if (!built.ok) throw new Error('invalid bridge route: ' + built.reason)
  return built.env
}

function defaults(input = {}) {
  return {
    codeHome: '/PROOF/private-a/codex-home',
    outputDir: '/PROOF/evidence',
    workspace: '/PROOF/workspace',
    bridgeCommand: '/PROOF/TaskWraith',
    endpoint: {
      socketPath: '/PROOF/broker.sock',
      brokerToken: 'f'.repeat(64),
      instanceEpoch: '0123456789abcdef0123456789abcdef',
      bridgeLogEpoch: 1
    },
    models: ['<MODEL_A>', '<MODEL_B>'],
    runtimes: [
      { id: 'default', binary: 'codex', env: {} },
      { id: 'alternate', binary: '<ALTERNATE_CODEX_BINARY>', env: {} }
    ],
    ...input
  }
}

function materializeCase(spec, input = {}) {
  const manifest = defaults(input)
  if (spec.mixedPermissions && manifest.mixedPermissionRoutes)
    manifest.routes = manifest.mixedPermissionRoutes
  const allProfiles = profiles()
  const runtime = manifest.runtimes[spec.runtimeIndex]
  if (!runtime) throw new Error('runtime profile not configured')
  const baseArgs = observerArgs(
    manifest.bridgeCommand,
    bridgeArgs(spec.registration, manifest.endpoint, allProfiles[1]),
    'daemon-default'
  )
  const daemon = {
    command: runtime.binary,
    args: [
      'app-server',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'mcp_servers={}',
      ...buildCodexTaskWraithMcpArgs({
        enabled: spec.bridgeEnabled,
        bridgeBinaryPath: process.execPath,
        bridgeArgs: baseArgs,
        parentProvider: 'codex'
      })
    ],
    inheritEnv: SAFE_ENV_KEYS,
    env: {
      ...runtime.env,
      CODEX_HOME: manifest.codeHome,
      TASKWRAITH_PROOF_ROOT: manifest.outputDir,
      TASKWRAITH_PROOF_EVENT_FILE: path.join(manifest.outputDir, 'events.jsonl')
    }
  }
  if (spec.bridgeEnabled) {
    daemon.args.push(
      '-c',
      'mcp_servers.TaskWraith.env={ ' +
        formatTomlInlineStringTable({
          TASKWRAITH_PARENT_PROVIDER: 'codex',
          TASKWRAITH_PROOF_ROOT: manifest.outputDir,
          TASKWRAITH_PROOF_EVENT_FILE: path.join(manifest.outputDir, 'events.jsonl')
        }) +
        ' }'
    )
  }
  const seats = allProfiles.map((profile, index) => ({
    role: profile.role,
    profileId: profile.id,
    model: manifest.models[spec.mixedModels && index % 2 ? 1 : 0],
    sandbox: spec.mixedPermissions && index % 2 ? 'workspace-write' : 'read-only',
    signedPresetId: spec.mixedPermissions && index % 2 ? 'workspace_write' : 'read_only',
    approvalPolicy: 'on-request',
    lifecycles: LIFECYCLES.map((lifecycle) => {
      // Change the requested profile on resume so a cached child/catalogue is observable.
      const requested =
        lifecycle === 'fresh' ? profile : allProfiles[(index + 1) % allProfiles.length]
      const tag = profile.role + '-' + lifecycle
      const env = routeEnvironment(manifest, profile.role, lifecycle, requested)
      env.TASKWRAITH_PROOF_ROOT = manifest.outputDir
      env.TASKWRAITH_PROOF_EVENT_FILE = path.join(manifest.outputDir, 'events.jsonl')
      env.TASKWRAITH_PROOF_HOLD_FILE = path.join(manifest.outputDir, profile.role + '.hold')
      env.TASKWRAITH_PROOF_SEAT = profile.role
      env.TASKWRAITH_PROOF_PHASE = lifecycle
      const args = observerArgs(
        manifest.bridgeCommand,
        bridgeArgs(spec.registration, manifest.endpoint, requested),
        tag
      )
      return {
        lifecycle,
        requestedProfileId: requested.id,
        postureDeclaration: manifest.routePostures?.[env.TASKWRAITH_RUN_ID] || null,
        argvTag: spec.perThreadArgs ? tag : 'daemon-default',
        config: spec.bridgeEnabled
          ? {
              'mcp_servers.TaskWraith.env': env,
              ...(spec.perThreadArgs ? { 'mcp_servers.TaskWraith.args': args } : {})
            }
          : {},
        expectedRoute: { appRunId: env.TASKWRAITH_RUN_ID, appChatId: env.TASKWRAITH_CHAT_ID },
        expectedEnvSha256: require('./common.cjs').fingerprint(env)
      }
    })
  }))
  return { ...spec, daemon, seats, observables: OBSERVABLES }
}

function createProofPlan(input = {}) {
  const cases = []
  for (const registration of ['direct', 'route-env'])
    for (const perThreadArgs of [false, true]) {
      for (const runtimeIndex of [0, 1])
        for (const mixedModels of [false, true]) {
          for (const mixedPermissions of [false, true])
            for (const bridgeEnabled of [true, false]) {
              const id = [
                registration,
                'args-' + Number(perThreadArgs),
                'runtime-' + runtimeIndex,
                'models-' + Number(mixedModels),
                'permissions-' + Number(mixedPermissions),
                'bridge-' + Number(bridgeEnabled)
              ].join('/')
              cases.push(
                materializeCase(
                  {
                    id,
                    registration,
                    perThreadArgs,
                    runtimeIndex,
                    mixedModels,
                    mixedPermissions,
                    bridgeEnabled
                  },
                  input
                )
              )
            }
        }
    }
  const representative = cases.find(
    (item) => item.registration === 'route-env' && item.perThreadArgs && item.bridgeEnabled
  )
  const secondInstance = materializeCase(representative, {
    ...input,
    ...input.secondInstance,
    codeHome: input.secondCodeHome || '/PROOF/private-b/codex-home'
  })
  return {
    schemaVersion: 1,
    mode: 'plan',
    executed: false,
    protocolDocumentation: 'https://learn.chatgpt.com/docs/app-server',
    cases,
    specialCases: [
      {
        id: 'broker-restart',
        daemon: representative.daemon,
        threads: representative.seats,
        afterRestart:
          'same daemon and native ids; replace per-thread endpoint env with freshly supplied manifest values',
        procedure:
          'capture before; operator restarts real broker and supplies refreshed manifest; resume same native threads; require changed endpoint epoch',
        observables: OBSERVABLES
      },
      {
        id: 'dual-instance',
        instances: [representative, secondInstance],
        procedure:
          'two distinct private homes; canonical source lease held by A while B requests it; record busy/error or unexpected concurrent ownership; run B after A releases',
        observables: OBSERVABLES
      }
    ],
    interpretation:
      'This is a matrix and executable probe recipe, not proof. Unsupported, censored or missing observations never pass.',
    runtimeMixture:
      'Runtime profiles select separate daemon lifetimes; concurrent runtimes in one app instance remain an explicit compatibility exception.'
  }
}

module.exports = {
  ROLES,
  LIFECYCLES,
  OBSERVABLES,
  SAFE_ENV_KEYS,
  defaults,
  profiles,
  bridgeArgs,
  observerArgs,
  routeEnvironment,
  buildCodexTaskWraithMcpArgs,
  createProofPlan,
  materializeCase
}
