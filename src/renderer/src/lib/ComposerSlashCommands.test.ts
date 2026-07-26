import { describe, it, expect } from 'vitest'
import {
  CODEX_PALETTE_CORE,
  CLI_PROVIDER_PALETTE_CORE,
  COMPOSER_SLASH_GROUP_ORDER,
  buildComposerSlashCommandRegistry,
  filterComposerSlashCommands,
  hasSlashCommandPlaceholders,
  matchLeadingActionCommand,
  matchLeadingSlashCommand,
  matchStandaloneSlashCommandToken,
  paletteCoreForProvider,
  slashCommandDispatchPrefix,
  wrapPaletteItemAsSlashCommand,
  type ComposerSlashCommand
} from './ComposerSlashCommands'

describe('ComposerSlashCommands', () => {
  describe('wrapPaletteItemAsSlashCommand', () => {
    it('wraps a CommandPaletteItem as a palette-passthrough ComposerSlashCommand', () => {
      const item = CODEX_PALETTE_CORE[0]
      const wrapped = wrapPaletteItemAsSlashCommand(item)
      expect(wrapped.kind).toBe('palette-passthrough')
      expect(wrapped.id).toBe(item.id)
      expect(wrapped.command).toBe(item.command)
      expect(wrapped.label).toBe(item.label)
      expect(wrapped.description).toBe(item.description)
      expect(wrapped.group).toBe(item.group)
      // The original item is retained so the dispatcher can route it to
      // the existing handlePaletteCommand without losing fields like
      // `source` or `sourcePath`.
      expect(wrapped.paletteItem).toBe(item)
    })
  })

  describe('paletteCoreForProvider', () => {
    it('returns no commands for unavailable historical providers', () => {
      expect(paletteCoreForProvider('gemini')).toEqual([])
    })
    it('returns CLI_PROVIDER_PALETTE_CORE for cursor', () => {
      // Path-B Cursor runs native Cursor tools under --sandbox with no
      // TaskWraith MCP bridge, but every CLI Core command dispatches
      // TaskWraith-side (inspector tabs, Diff Studio, plan-mode /review,
      // emulated /fork) — see handlePaletteCommand's cursor branch.
      expect(paletteCoreForProvider('cursor')).toBe(CLI_PROVIDER_PALETTE_CORE)
    })
    it('returns CODEX_PALETTE_CORE for codex', () => {
      expect(paletteCoreForProvider('codex')).toBe(CODEX_PALETTE_CORE)
    })
    it('returns CLI_PROVIDER_PALETTE_CORE for claude', () => {
      expect(paletteCoreForProvider('claude')).toBe(CLI_PROVIDER_PALETTE_CORE)
    })
    it('returns CLI_PROVIDER_PALETTE_CORE for kimi', () => {
      expect(paletteCoreForProvider('kimi')).toBe(CLI_PROVIDER_PALETTE_CORE)
    })
    it('returns CLI_PROVIDER_PALETTE_CORE for grok', () => {
      // Grok's TUI slash commands (e.g. /code-review on 0.2.51) don't exist
      // over the headless/ACP run path; the generic CLI core gives a Grok
      // chat TaskWraith's own read-only /review + /diff.
      expect(paletteCoreForProvider('grok')).toBe(CLI_PROVIDER_PALETTE_CORE)
    })
    it('returns CLI_PROVIDER_PALETTE_CORE for ollama', () => {
      expect(paletteCoreForProvider('ollama')).toBe(CLI_PROVIDER_PALETTE_CORE)
    })
    it('returns CLI_PROVIDER_PALETTE_CORE for pi', () => {
      expect(paletteCoreForProvider('pi')).toBe(CLI_PROVIDER_PALETTE_CORE)
    })
    it('does not classify an admitted AntiGravity seat as retired', () => {
      expect(paletteCoreForProvider('antigravity')).toBe(CLI_PROVIDER_PALETTE_CORE)
    })
  })

  describe('buildComposerSlashCommandRegistry', () => {
    it('wraps every palette item as a palette-passthrough entry', () => {
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: CODEX_PALETTE_CORE
      })
      expect(result).toHaveLength(CODEX_PALETTE_CORE.length)
      for (const entry of result) {
        expect(entry.kind).toBe('palette-passthrough')
      }
    })

    it('appends extraCommands after the palette-passthrough block', () => {
      const extras: ComposerSlashCommand[] = [
        {
          kind: 'action',
          id: 'test-extra',
          command: '/test-extra',
          label: 'Test extra',
          description: 'Test description',
          group: 'Custom',
          run: () => undefined
        }
      ]
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: CODEX_PALETTE_CORE,
        extraCommands: extras
      })
      expect(result).toHaveLength(CODEX_PALETTE_CORE.length + 1)
      expect(result[result.length - 1].id).toBe('test-extra')
      expect(result[result.length - 1].kind).toBe('action')
    })

    it('dedupes duplicate command strings case-insensitively with later extras winning', () => {
      const basePaletteItem = {
        id: 'palette-review',
        command: '/review',
        label: 'Review',
        description: 'Show existing review command',
        group: 'Inspectors' as const,
        source: 'core' as const
      }
      const extras: ComposerSlashCommand[] = [
        {
          kind: 'action',
          id: 'first-review-override',
          command: '/ReViEw',
          label: 'First override',
          description: 'First override should lose',
          group: 'Custom',
          run: () => undefined
        },
        {
          kind: 'action',
          id: 'second-review-override',
          command: '/review',
          label: 'Second override',
          description: 'Later duplicate should win',
          group: 'Custom',
          run: () => undefined
        },
        {
          kind: 'action',
          id: 'unique-action',
          command: '/custom',
          label: 'Custom',
          description: 'Unique action',
          group: 'Custom',
          run: () => undefined
        }
      ]
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: [basePaletteItem],
        extraCommands: extras
      })

      const reviewCommand = result.find((entry) => entry.command.toLowerCase() === '/review')
      expect(reviewCommand).toBeDefined()
      expect(reviewCommand?.id).toBe('second-review-override')
      expect(result).toContainEqual(
        expect.objectContaining({
          id: 'unique-action',
          command: '/custom'
        })
      )
      expect(result).toHaveLength(2)
    })

    it('produces a registry with no duplicate command tokens after dedupe', () => {
      const extras: ComposerSlashCommand[] = [
        {
          kind: 'action',
          id: 'palette-review-override',
          command: '/STATUS',
          label: 'Status override',
          description: 'Override status command',
          group: 'Core',
          run: () => undefined
        },
        {
          kind: 'action',
          id: 'first-duplicate-model',
          command: '/MODEL',
          label: 'Model override',
          description: 'First model override',
          group: 'Core',
          run: () => undefined
        },
        {
          kind: 'action',
          id: 'second-duplicate-model',
          command: '/model',
          label: 'Model override final',
          description: 'Second model override',
          group: 'Core',
          run: () => undefined
        }
      ]
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: CODEX_PALETTE_CORE,
        extraCommands: extras
      })

      const normalizedCommands = result.map((entry) => entry.command.toLowerCase())
      expect(new Set(normalizedCommands).size).toBe(normalizedCommands.length)
      expect(result).toHaveLength(normalizedCommands.length)
      expect(result).toHaveLength(9)
      const statusCommand = result.find((entry) => entry.command.toLowerCase() === '/status')
      expect(statusCommand?.id).toBe('palette-review-override')
      const modelCommand = result.find((entry) => entry.command.toLowerCase() === '/model')
      expect(modelCommand?.id).toBe('second-duplicate-model')
      expect(result[0]?.id).toBe('palette-review-override')
      expect(result[1]?.id).toBe('second-duplicate-model')
    })

    it('produces an empty registry when no items are provided', () => {
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: []
      })
      expect(result).toEqual([])
    })

    it('returns an empty registry for unavailable historical providers', () => {
      const extraCommand: ComposerSlashCommand = {
        kind: 'action',
        id: 'must-not-run',
        command: '/must-not-run',
        label: 'Must not run',
        description: 'Would dispatch an action if this provider were live.',
        group: 'Custom',
        run: () => undefined
      }
      expect(
        buildComposerSlashCommandRegistry({
          provider: 'gemini',
          paletteItems: CLI_PROVIDER_PALETTE_CORE,
          extraCommands: [extraCommand]
        })
      ).toEqual([])
    })

    it('retains commands for an already-admitted AntiGravity seat', () => {
      const result = buildComposerSlashCommandRegistry({
        provider: 'antigravity',
        paletteItems: CLI_PROVIDER_PALETTE_CORE
      })
      expect(result).toHaveLength(CLI_PROVIDER_PALETTE_CORE.length)
      expect(result.map((command) => command.command)).toContain('/fork')
    })
  })

  describe('filterComposerSlashCommands', () => {
    const registry = buildComposerSlashCommandRegistry({
      provider: 'codex',
      paletteItems: CODEX_PALETTE_CORE
    })

    it('returns all commands when query is empty', () => {
      expect(filterComposerSlashCommands(registry, '')).toEqual(registry)
      expect(filterComposerSlashCommands(registry, '   ')).toEqual(registry)
    })

    it('matches case-insensitively against the slash command text', () => {
      const result = filterComposerSlashCommands(registry, 'FORK')
      expect(result).toHaveLength(1)
      expect(result[0].command).toBe('/fork')
    })

    it('matches against the label and description', () => {
      // "review" appears in /review's label AND description; expect both
      // matches at least.
      const result = filterComposerSlashCommands(registry, 'review')
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result.some((entry) => entry.command === '/review')).toBe(true)
    })

    it('matches against the group label', () => {
      const result = filterComposerSlashCommands(registry, 'Inspectors')
      const inspectorEntries = registry.filter((entry) => entry.group === 'Inspectors')
      expect(result).toHaveLength(inspectorEntries.length)
    })

    it('returns no entries when nothing matches', () => {
      expect(filterComposerSlashCommands(registry, '__never_appears__')).toEqual([])
    })
  })

  describe('matchLeadingActionCommand', () => {
    const auditCommand = {
      kind: 'action',
      id: 'audit',
      command: '/audit',
      label: 'Audit',
      description: 'Run audit workflow',
      group: 'Custom',
      run: () => undefined
    } satisfies ComposerSlashCommand
    const clearCommand = {
      kind: 'action',
      id: 'clear',
      command: '/clear',
      label: 'Clear',
      description: 'Clear transcript',
      group: 'Custom',
      run: () => undefined
    } satisfies ComposerSlashCommand
    const registry = buildComposerSlashCommandRegistry({
      provider: 'codex',
      paletteItems: CODEX_PALETTE_CORE,
      extraCommands: [auditCommand, clearCommand]
    })

    it('matches a leading action command with trailing args', () => {
      expect(matchLeadingActionCommand('/audit quick', registry)).toBe(auditCommand)
    })

    it('matches action commands case-insensitively', () => {
      expect(matchLeadingActionCommand('  /AuDiT deep  ', registry)).toBe(auditCommand)
    })

    it('does not match non-leading action commands inside normal prose', () => {
      expect(matchLeadingActionCommand('please run /audit quick', registry)).toBeNull()
    })

    it('does not match provider palette passthrough commands', () => {
      expect(matchLeadingActionCommand('/review this diff', registry)).toBeNull()
    })

    it('does not match action command prefixes as full commands', () => {
      expect(matchLeadingActionCommand('/audit-trail quick', registry)).toBeNull()
    })
  })

  describe('matchLeadingSlashCommand', () => {
    it('matches the longest registered command, including multi-word commands', () => {
      const registry = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: [
          {
            id: 'custom-commands-list',
            command: '/commands list',
            label: 'List commands',
            description: 'List available commands.',
            group: 'Discovery',
            source: 'core'
          },
          {
            id: 'custom-commands-reload',
            command: '/commands reload',
            label: 'Reload commands',
            description: 'Reload available commands.',
            group: 'Discovery',
            source: 'core'
          }
        ]
      })

      const match = matchLeadingSlashCommand('/commands reload now', registry)
      expect(match?.command.command).toBe('/commands reload')
      expect(match?.remainder).toBe('now')
    })

    it('does not collapse incomplete multi-word commands to a sibling prefix', () => {
      const registry = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: [
          {
            id: 'custom-commands-list',
            command: '/commands list',
            label: 'List commands',
            description: 'List available commands.',
            group: 'Discovery',
            source: 'core'
          }
        ]
      })

      expect(matchLeadingSlashCommand('/commands', registry)).toBeNull()
    })

    it('matches prompt templates but excludes insert-only commands from submit dispatch', () => {
      const templateCommand = {
        kind: 'prompt-template',
        id: 'template-explain',
        command: '/explain',
        label: 'Explain',
        description: 'Explain template',
        group: 'Custom',
        template: 'Explain:\n\n'
      } satisfies ComposerSlashCommand
      const insertCommand = {
        kind: 'insert',
        id: 'insert-meta',
        command: '/meta',
        label: 'Meta',
        description: 'Insert meta prefix',
        group: 'Custom',
        insertText: '/meta '
      } satisfies ComposerSlashCommand
      const registry = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: [],
        extraCommands: [templateCommand, insertCommand]
      })

      expect(matchLeadingSlashCommand('/explain this function', registry)).toMatchObject({
        command: templateCommand,
        remainder: 'this function'
      })
      expect(matchLeadingSlashCommand('/meta discuss the harness', registry)).toBeNull()
    })

    it('matches discovered command placeholders as arguments instead of literal tokens', () => {
      const customPaletteItem = {
        id: 'custom-review-path',
        command: '/project:review <path>',
        label: 'Review path',
        description: 'Review a path',
        group: 'Custom' as const,
        source: 'workspace' as const
      }
      const registry = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: [customPaletteItem]
      })

      expect(hasSlashCommandPlaceholders(customPaletteItem.command)).toBe(true)
      expect(slashCommandDispatchPrefix(customPaletteItem.command)).toBe('/project:review')
      expect(matchLeadingSlashCommand('/project:review src/App.tsx', registry)).toMatchObject({
        command: expect.objectContaining({ command: '/project:review <path>' }),
        matchedText: '/project:review',
        remainder: 'src/App.tsx'
      })
    })
  })

  describe('matchStandaloneSlashCommandToken', () => {
    it('matches and removes a standalone slash command inside prose', () => {
      expect(matchStandaloneSlashCommandToken('Fix this /goal today', '/goal')).toEqual({
        start: 9,
        end: 14,
        matchedText: '/goal',
        promptWithoutToken: 'Fix this today'
      })
    })

    it('matches standalone commands at the start or end of the draft', () => {
      expect(matchStandaloneSlashCommandToken('/goal Fix this', '/goal')).toMatchObject({
        start: 0,
        end: 5,
        promptWithoutToken: ' Fix this'
      })
      expect(matchStandaloneSlashCommandToken('Fix this /goal', '/goal')).toMatchObject({
        start: 9,
        end: 14,
        promptWithoutToken: 'Fix this '
      })
    })

    it('rejects command-looking text merged with other characters', () => {
      expect(matchStandaloneSlashCommandToken('Fix/goal this', '/goal')).toBeNull()
      expect(matchStandaloneSlashCommandToken('Fix /goalish today', '/goal')).toBeNull()
      expect(matchStandaloneSlashCommandToken('Fix /goal,today', '/goal')).toBeNull()
      expect(matchStandaloneSlashCommandToken('Fix /goal: today', '/goal')).toBeNull()
      expect(matchStandaloneSlashCommandToken('Fix /goal. today', '/goal')).toBeNull()
      expect(matchStandaloneSlashCommandToken('See https://example.test/goal today', '/goal')).toBeNull()
    })

    it('does not match multi-word command declarations as inline tokens', () => {
      expect(matchStandaloneSlashCommandToken('Reload /commands reload', '/commands reload')).toBeNull()
    })
  })

  describe('capability gating', () => {
    const minimalCapabilities = (overrides: Partial<{ mcpAvailable: boolean }>) => ({
      provider: 'codex' as const,
      label: 'Codex',
      refreshedAt: '2026-05-23T00:00:00.000Z',
      availability: {
        state: 'available' as const,
        binaryPath: '/usr/bin/codex',
        message: ''
      },
      tools: {} as Record<string, never>,
      approvals: {
        currentMode: 'default' as const,
        allowedModes: ['default' as const],
        source: 'taskwraith' as const,
        message: ''
      },
      mcp: {
        enabled: true,
        installed: true,
        available: overrides.mcpAvailable ?? true,
        delegated: false,
        serverName: 'codex-mcp',
        source: 'taskwraith' as const,
        message: ''
      },
      warnings: []
    })

    it('keeps /mcp when capabilities.mcp.available is true', () => {
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: CODEX_PALETTE_CORE,
        capabilities: minimalCapabilities({ mcpAvailable: true }) as any
      })
      expect(result.some((entry) => entry.command === '/mcp')).toBe(true)
    })

    it('hides /mcp when capabilities.mcp.available is false', () => {
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: CODEX_PALETTE_CORE,
        capabilities: minimalCapabilities({ mcpAvailable: false }) as any
      })
      expect(result.some((entry) => entry.command === '/mcp')).toBe(false)
    })

    it('leaves all entries visible when no capability snapshot is supplied', () => {
      const result = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: CODEX_PALETTE_CORE
      })
      expect(result.some((entry) => entry.command === '/mcp')).toBe(true)
    })
  })

  describe('group ordering', () => {
    it('matches the Cmd-K palette group order (Core → Discovery → Memory → Inspectors → Custom)', () => {
      expect(COMPOSER_SLASH_GROUP_ORDER).toEqual([
        'Core',
        'Discovery',
        'Memory',
        'Inspectors',
        'Custom'
      ])
    })
  })

  describe('per-provider palette parity', () => {
    it('Codex palette CORE has the expected entries', () => {
      const ids = CODEX_PALETTE_CORE.map((entry) => entry.id)
      expect(ids).toEqual([
        'codex-status',
        'codex-model',
        'codex-fast',
        'codex-diff',
        'codex-mcp',
        'codex-review',
        'codex-resume',
        'universal-fork',
        'codex-permissions'
      ])
    })

    it('CLI provider palette CORE has the expected entries', () => {
      const ids = CLI_PROVIDER_PALETTE_CORE.map((entry) => entry.id)
      expect(ids).toEqual([
        'cli-provider-status',
        'cli-provider-model',
        'cli-provider-diff',
        'cli-provider-review',
        'cli-provider-permissions',
        'cli-universal-fork'
      ])
    })
  })
})
