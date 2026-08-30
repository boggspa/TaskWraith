import { describe, expect, it } from 'vitest'
import {
  TUI_SLASH_COMMANDS,
  filterTuiSlashCommands,
  parseLeadingTuiSlashToken,
  resolveTuiSlashCommand
} from './slashCommands'

describe('TaskWraith TUI slash-command registry', () => {
  it('covers every command and alias accepted by the current dispatcher', () => {
    expect(TUI_SLASH_COMMANDS.map((command) => command.name).sort()).toEqual(
      [
        '/archive',
        '/cancel',
        '/clear',
        '/context',
        '/dismiss',
        '/git',
        '/goal',
        '/help',
        '/history',
        '/login',
        '/missions',
        '/model',
        '/new',
        '/quit',
        '/seats',
        '/status',
        '/theme',
        '/think',
        '/threads',
        '/tune',
        '/workspace'
      ].sort()
    )
    expect(
      Object.fromEntries(
        TUI_SLASH_COMMANDS.filter((command) => command.aliases.length).map((command) => [
          command.name,
          command.aliases
        ])
      )
    ).toEqual({
      '/model': ['/m'],
      '/new': ['/provider'],
      '/quit': ['/q'],
      '/think': ['/reasoning'],
      '/workspace': ['/ws']
    })

    const allTokens = TUI_SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases])
    expect(new Set(allTokens).size).toBe(allTokens.length)
    expect(TUI_SLASH_COMMANDS.every((command) => command.usage.startsWith(command.name))).toBe(true)
  })

  it('marks only commands that immediately interrupt or discard state as destructive', () => {
    expect(
      TUI_SLASH_COMMANDS.filter((command) => command.destructive).map((command) => command.name)
    ).toEqual(['/archive', '/cancel', '/dismiss', '/quit'])
  })

  it('parses only a leading token and preserves useful argument forms', () => {
    expect(parseLeadingTuiSlashToken('  /MODEL   gpt-5.6  high  ')).toEqual({
      rawToken: '/MODEL',
      normalizedToken: '/model',
      argumentText: 'gpt-5.6  high',
      arguments: ['gpt-5.6', 'high']
    })
    expect(parseLeadingTuiSlashToken('/')).toEqual({
      rawToken: '/',
      normalizedToken: '/',
      argumentText: '',
      arguments: []
    })
    expect(parseLeadingTuiSlashToken('explain /status')).toBeNull()
  })

  it('filters canonical names and aliases, ranking exact aliases ahead of prefixes', () => {
    expect(filterTuiSlashCommands('/')).toHaveLength(TUI_SLASH_COMMANDS.length)
    expect(
      filterTuiSlashCommands('/m')
        .slice(0, 2)
        .map((command) => command.name)
    ).toEqual(['/model', '/missions'])
    expect(filterTuiSlashCommands('/rea')[0]?.name).toBe('/think')
    expect(filterTuiSlashCommands('/git diff').map((command) => command.name)).toEqual(['/git'])
    expect(filterTuiSlashCommands('colour theme').map((command) => command.name)).toEqual([
      '/theme'
    ])
    expect(filterTuiSlashCommands('/not-a-command')).toEqual([])
  })

  it('resolves exact canonical tokens and aliases without accepting prefixes', () => {
    expect(resolveTuiSlashCommand('/ThReAdS')?.command.name).toBe('/threads')
    expect(resolveTuiSlashCommand('/m gpt-5.6')).toMatchObject({
      command: { name: '/model' },
      rawToken: '/m',
      argumentText: 'gpt-5.6',
      arguments: ['gpt-5.6']
    })
    expect(resolveTuiSlashCommand('/provider claude')?.command.name).toBe('/new')
    expect(resolveTuiSlashCommand('/reasoning high')?.command.name).toBe('/think')
    expect(resolveTuiSlashCommand('/ws /Users/A Workspace')?.command.name).toBe('/workspace')
    expect(resolveTuiSlashCommand('/q')?.command.name).toBe('/quit')
    expect(resolveTuiSlashCommand('/mod')).toBeNull()
    expect(resolveTuiSlashCommand('say /model')).toBeNull()
  })
})
