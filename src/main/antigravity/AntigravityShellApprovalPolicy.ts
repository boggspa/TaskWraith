import { classifyReleaseCommand } from '../ReleaseCommandPolicy'

export type AntigravityShellApprovalService = 'shellCommands' | 'externalPublish'

/**
 * Shell calls whose ordinary permission classification is intentionally lifted
 * for AntiGravity under every posture. These are the exact commands the user
 * approved as a standing product rule on 2026-08-13 after a read-clamped Scout
 * lane presented redundant approval cards.
 *
 * Exact matching is load-bearing. In particular, do not generalize `node -e`,
 * package scripts, PATH assignments, or command substitution: each can execute
 * arbitrary workspace-controlled code in a different spelling. Outer
 * whitespace is ignored because agy may preserve transport padding; every byte
 * inside the command must otherwise match one reviewed invocation.
 */
const USER_AUTHORIZED_COMMANDS: ReadonlySet<string> = new Set([
  'npm run work-guard',
  'export PATH=$PATH:/opt/homebrew/bin; npm run work-guard',
  'export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin; which npm node swift',
  `export PATH=$PATH:/opt/homebrew/bin; node -e "const p = require('./package.json'); console.log(JSON.stringify(p.scripts, null, 2));"`
])

export function isAntigravityUserAuthorizedShellCommand(command: unknown): boolean {
  return typeof command === 'string' && USER_AUTHORIZED_COMMANDS.has(command.trim())
}

/**
 * Preserve the permission ladder for publish/release commands even though agy
 * exposes them through its generic `run_command` tool. Accept Edits authorizes
 * ordinary shell work, but external publication remains a Full WS Access /
 * Full Access service.
 */
export function antigravityShellApprovalService(command: unknown): AntigravityShellApprovalService {
  return classifyReleaseCommand(command) ? 'externalPublish' : 'shellCommands'
}
