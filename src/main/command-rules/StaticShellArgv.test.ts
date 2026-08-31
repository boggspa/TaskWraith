import { describe, expect, it } from 'vitest'
import { parseStaticShellArgv } from './StaticShellArgv'

describe('parseStaticShellArgv', () => {
  it('normalizes literal quotes into direct argv', () => {
    expect(parseStaticShellArgv('rg -n "canvas panel" src')).toEqual({
      ok: true,
      value: { executable: 'rg', argv: ['-n', 'canvas panel', 'src'] }
    })
    expect(parseStaticShellArgv("rg -n 'canvas.*panel' src")).toEqual({
      ok: true,
      value: { executable: 'rg', argv: ['-n', 'canvas.*panel', 'src'] }
    })
  })

  it.each([
    ['command substitution', 'echo $(whoami)', 'unsafe_syntax'],
    ['parameter expansion', 'echo $HOME', 'unsafe_syntax'],
    ['redirection', 'cat package.json > copy.json', 'unsafe_syntax'],
    ['pipeline', 'rg TODO src | head -n 10', 'unsafe_syntax'],
    ['control operator', 'npm test && npm run lint', 'unsafe_syntax'],
    ['unquoted glob', 'ls src/*.ts', 'unsafe_syntax'],
    ['environment assignment', 'NODE_ENV=test npm test', 'environment_assignment'],
    ['shell wrapper', "sh -c 'npm test'", 'shell_wrapper'],
    ['absolute shell wrapper', "/bin/sh -c 'npm test'", 'shell_wrapper'],
    ['unterminated quote', "rg 'missing", 'unterminated_quote']
  ])('rejects %s', (_label, command, reason) => {
    expect(parseStaticShellArgv(command)).toEqual({ ok: false, reason })
  })
})
