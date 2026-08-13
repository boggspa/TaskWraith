import { describe, expect, it } from 'vitest'
import {
  antigravityShellApprovalService,
  isAntigravityUserAuthorizedShellCommand
} from './AntigravityShellApprovalPolicy'

const USER_AUTHORIZED_COMMANDS = [
  'npm run work-guard',
  'export PATH=$PATH:/opt/homebrew/bin; npm run work-guard',
  'export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin; which npm node swift',
  `export PATH=$PATH:/opt/homebrew/bin; node -e "const p = require('./package.json'); console.log(JSON.stringify(p.scripts, null, 2));"`
]

describe('isAntigravityUserAuthorizedShellCommand', () => {
  it('matches every non-Git command captured in the approval screenshots', () => {
    for (const command of USER_AUTHORIZED_COMMANDS) {
      expect(isAntigravityUserAuthorizedShellCommand(command), command).toBe(true)
      expect(isAntigravityUserAuthorizedShellCommand(`  ${command}\n`), command).toBe(true)
    }
  })

  it('keeps near misses and arbitrary interpreter/package commands on the normal gate', () => {
    for (const command of [
      'npm run work-guard -- --write',
      'npm run work-guard && rm -rf .',
      'export PATH=$PATH:/opt/homebrew/bin; npm test',
      `node -e "require('fs').unlinkSync('package.json')"`,
      `export PATH=$PATH:/opt/homebrew/bin; node -e "const p = require('./package.json'); console.log(p);"`,
      'export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin:$(touch /tmp/pwn); which npm node swift',
      null,
      42
    ]) {
      expect(isAntigravityUserAuthorizedShellCommand(command), String(command)).toBe(false)
    }
  })
})

describe('antigravityShellApprovalService', () => {
  it('keeps ordinary native commands on the shell service', () => {
    for (const command of [...USER_AUTHORIZED_COMMANDS, 'npm test', 'git diff --check']) {
      expect(antigravityShellApprovalService(command), command).toBe('shellCommands')
    }
  })

  it('routes publish and release-class native commands to the higher tier', () => {
    for (const command of [
      'git push origin master',
      'gh pr create --fill',
      'npm publish',
      'npm run deploy',
      'npx semantic-release'
    ]) {
      expect(antigravityShellApprovalService(command), command).toBe('externalPublish')
    }
  })
})
