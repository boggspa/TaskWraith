import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightNativeWorkspaceTool } from './NativeWorkspaceToolGate'

const roots: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-native-gate-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'inside.txt'), 'inside')
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('preflightNativeWorkspaceTool', () => {
  it('coalesces an exact declared Grok alias and allows an in-workspace native read', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Read file',
        toolKind: 'read',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'allow',
      canonicalTool: 'read_file',
      service: 'mcpTools',
      access: 'read',
      checkedPaths: [join(root, 'src', 'inside.txt')]
    })
  })

  it('uses provider + ACP tool kind while treating the human title as display-only', () => {
    const root = workspace()
    for (const provider of ['grok', 'mistral'] as const) {
      expect(
        preflightNativeWorkspaceTool({
          provider,
          toolName: 'Write file src/generated.ts',
          toolKind: 'edit',
          rawToolCall: { rawInput: { path: 'src/generated.ts', content: 'body' } },
          workspacePath: root
        })
      ).toMatchObject({
        kind: 'allow',
        canonicalTool: 'write_file',
        access: 'write'
      })
    }

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'A completely different human title',
        toolKind: 'edit',
        rawToolCall: { rawInput: { path: 'src/generated.ts', content: 'body' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'allow',
      canonicalTool: 'write_file',
      access: 'write'
    })

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Write file src/generated.ts',
        toolKind: 'search',
        rawToolCall: { rawInput: { path: 'src/generated.ts', content: 'body' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'native_action_not_declared'
    })

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Harmless read title',
        toolKind: 'read',
        rawToolCall: {
          kind: 'read',
          rawInput: { path: 'src/inside.txt', command: 'rm -rf ../outside' }
        },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'native_action_not_declared'
    })

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Untrusted display title',
        toolKind: 'read',
        rawToolCall: {
          kind: 'read',
          rawInput: { tool_name: 'TotallyNewExfiltrateTool', path: 'src/inside.txt' }
        },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'native_action_not_declared'
    })
  })

  it('requires provider identity before resolving any native alias', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'Read',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'provider_identity_required'
    })
  })

  it('normalizes benign traversal but denies parent and sibling-prefix escapes', () => {
    const root = workspace()
    const inside = preflightNativeWorkspaceTool({
      provider: 'grok',
      toolName: 'Read',
      toolKind: 'read',
      rawToolCall: { rawInput: { path: 'src/../src/inside.txt' } },
      workspacePath: root
    })
    expect(inside).toMatchObject({ kind: 'allow', canonicalTool: 'read_file' })

    for (const path of ['../outside.txt', `${root}-sibling/secret.txt`]) {
      expect(
        preflightNativeWorkspaceTool({
          provider: 'grok',
          toolName: 'Read',
          toolKind: 'read',
          rawToolCall: { rawInput: { path } },
          workspacePath: root
        })
      ).toMatchObject({ kind: 'deny', canonicalTool: 'read_file' })
    }
  })

  it('denies an in-workspace symlink whose authority resolves outside', () => {
    const root = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'taskwraith-native-gate-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(root, 'escape'))

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Read',
        toolKind: 'read',
        rawToolCall: { rawInput: { path: 'escape/secret.txt' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'read_file' })
  })

  it('checks every source/destination path for native move and rename calls', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Move file',
        toolKind: 'move',
        rawToolCall: { rawInput: { source: 'src/inside.txt', destination: 'moved.txt' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'allow', canonicalTool: 'move_path', access: 'write' })

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Move file',
        toolKind: 'move',
        rawToolCall: { rawInput: { source: 'src/inside.txt', destination: '../moved.txt' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'move_path' })
  })

  it('extracts unified-diff paths before allowing native apply_patch', () => {
    const root = workspace()
    const patch = [
      '--- a/src/inside.txt',
      '+++ b/src/inside.txt',
      '@@ -1 +1 @@',
      '-inside',
      '+updated'
    ].join('\n')
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'apply_patch',
        toolKind: 'edit',
        rawToolCall: { rawInput: { patch } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'allow', canonicalTool: 'apply_patch', access: 'write' })
  })

  it('fails closed when a path-bearing native tool omits its authority', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Write file',
        toolKind: 'edit',
        rawToolCall: { rawInput: { content: 'body' } },
        workspacePath: root
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'write_file' })
  })

  it('clamps shell cwd and requires a hard runtime sandbox', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'run_terminal_command',
        toolKind: 'execute',
        rawToolCall: { rawInput: { command: 'pwd', cwd: '/tmp' } },
        workspacePath: root,
        runtimeSandboxed: true
      })
    ).toMatchObject({ kind: 'deny', canonicalTool: 'run_shell_command' })

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'run_terminal_command',
        toolKind: 'execute',
        rawToolCall: { rawInput: { command: 'pwd', cwd: 'src' } },
        workspacePath: root,
        runtimeSandboxed: false
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: 'run_shell_command',
      requiresRuntimeSandbox: true
    })

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'run_terminal_command',
        toolKind: 'execute',
        rawToolCall: { rawInput: { command: 'pwd', cwd: 'src' } },
        workspacePath: root,
        runtimeSandboxed: true
      })
    ).toMatchObject({
      kind: 'allow',
      canonicalTool: 'run_shell_command',
      access: 'shell',
      normalizedCwd: join(root, 'src'),
      requiresRuntimeSandbox: true
    })
  })

  it('leaves TaskWraith-qualified tools to the broker and ignores unrelated native tools', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'tool',
        rawToolCall: {
          rawInput: { tool_name: 'taskwraith-broker__write_file', path: '../outside.txt' }
        },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'not_applicable',
      source: 'taskwraith',
      canonicalTool: 'write_file'
    })
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'mcp__taskwraith__capability_search',
        rawToolCall: { rawInput: { query: 'release gates' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'not_applicable',
      source: 'taskwraith',
      canonicalTool: 'capability_search'
    })
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'mcp__taskwraith__capability_invoke',
        rawToolCall: {
          rawInput: {
            name: 'write_file',
            arguments: { path: 'src/generated.ts', content: 'body' }
          }
        },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'not_applicable',
      source: 'taskwraith',
      canonicalTool: 'capability_invoke'
    })
    expect(
      preflightNativeWorkspaceTool({
        toolName: 'mcp__taskwraith__audit_record_finding',
        rawToolCall: { rawInput: { finding: {} } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'not_applicable',
      source: 'taskwraith',
      canonicalTool: 'audit_record_finding'
    })
    expect(
      preflightNativeWorkspaceTool({
        provider: 'claude',
        toolName: 'AskUserQuestion',
        toolKind: 'other',
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      source: 'native',
      errorCode: 'native_surface_closed'
    })
  })

  it('never treats an ACP human title as broker provenance', () => {
    const root = workspace()
    for (const [provider, title] of [
      ['grok', 'taskwraith-broker__write_file'],
      ['grok', 'taskwraith-grok__write_file'],
      ['grok', 'mcp__taskwraith__write_file'],
      ['mistral', 'taskwraith-mistral__write_file']
    ] as const) {
      expect(
        preflightNativeWorkspaceTool({
          provider,
          toolName: title,
          toolKind: 'edit',
          rawToolCall: {
            title,
            kind: 'edit',
            rawInput: { path: '../outside.txt', content: 'owned' }
          },
          workspacePath: root,
          runtimeSandboxed: false
        }),
        `${provider}:${title}`
      ).toMatchObject({
        kind: 'deny',
        source: 'native',
        canonicalTool: 'write_file'
      })
    }
  })

  it('accepts only the ACP raw machine field as stable broker identity', () => {
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'display title only',
        toolKind: 'other',
        rawToolCall: {
          title: 'display title only',
          kind: 'other',
          rawInput: {
            tool_name: 'taskwraith-grok__read_file',
            path: 'README.md'
          }
        },
        workspacePath: workspace()
      })
    ).toMatchObject({
      kind: 'not_applicable',
      source: 'taskwraith',
      canonicalTool: 'read_file'
    })
  })

  it('fails explicit for undeclared, catalog-only, and unobservable provider actions', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        provider: 'claude',
        toolName: 'TeleportRepository',
        toolKind: 'edit',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'native_surface_closed'
    })
    expect(
      preflightNativeWorkspaceTool({
        provider: 'kimi',
        toolName: 'Read',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      errorCode: 'native_surface_closed'
    })
    expect(
      preflightNativeWorkspaceTool({
        provider: 'pi',
        toolName: 'edit',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      errorCode: 'native_surface_unobservable'
    })
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'display title',
        toolKind: 'other',
        rawToolCall: {
          rawInput: { tool_name: 'taskwraith-broker__future_unmapped_action' }
        },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      errorCode: 'unmapped_catalog_action'
    })
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'display title',
        toolKind: 'other',
        rawToolCall: {
          rawInput: { tool_name: 'mcp__evil__write_file', path: '../outside.txt' }
        },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'unmapped_catalog_action'
    })
  })

  it('does not infer authority from suggestive titles outside an adapter declaration', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        provider: 'claude',
        toolName: 'Read file src/inside.txt',
        toolKind: 'read',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'native_surface_closed'
    })

    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'Inspect file src/inside.txt',
        toolKind: 'other',
        rawToolCall: { rawInput: { path: 'src/inside.txt' } },
        workspacePath: root
      })
    ).toMatchObject({
      kind: 'deny',
      canonicalTool: null,
      errorCode: 'native_action_not_declared'
    })
  })
  // Search and listing tools carry their target in a per-tool SCOPE field. Before
  // this, `Grep {include:'/etc/**'}` and `Glob {pattern:'../../**'}` reached the
  // optional-path branch and were ALLOWED with checkedPaths empty — and because
  // they are reads, that meant no approval card and no audit row either. Shipped
  // in 1.9.1; confirmed identical on master before fixing.
  const searchCall = (root: string, rawInput: Record<string, unknown>) =>
    preflightNativeWorkspaceTool({
      provider: 'grok',
      toolName: 'tool',
      toolKind: 'search',
      rawToolCall: { kind: 'search', rawInput },
      workspacePath: root,
      runtimeSandboxed: false
    })

  it('contains a search scope that reaches outside the workspace', () => {
    const root = workspace()
    expect(
      searchCall(root, { tool_name: 'Grep', pattern: 'x', path: 'src', include: '/etc/**' })
    ).toMatchObject({
      kind: 'deny'
    })
    expect(searchCall(root, { tool_name: 'Glob', pattern: '../../*.pem' })).toMatchObject({
      kind: 'deny'
    })
  })

  // The reason these fields cannot simply join PATH_FIELDS: `pattern` is the path
  // expression for Glob but the SEARCH REGEX for Grep. Treating it as a path
  // everywhere would refuse every grep whose regex happens to contain slashes.
  it('treats pattern as a scope for Glob and as a regex for Grep', () => {
    const root = workspace()
    expect(searchCall(root, { tool_name: 'Glob', pattern: 'src/**/*.txt' })).toMatchObject({
      kind: 'allow',
      canonicalTool: 'find_files'
    })
    expect(
      searchCall(root, { tool_name: 'Grep', pattern: '../../etc/passwd', path: 'src' })
    ).toMatchObject({ kind: 'allow', canonicalTool: 'workspace_search' })
    expect(
      searchCall(root, { tool_name: 'Grep', pattern: 'foo/bar/../baz', path: 'src' })
    ).toMatchObject({ kind: 'allow', canonicalTool: 'workspace_search' })
  })

  // The gate validates the caller's argument but never rewrites it, so a path the
  // executor may tilde-expand cannot be contained: `~/.ssh/id_rsa` used to resolve
  // as a literal in-workspace `<ws>/~/.ssh/id_rsa` and pass.
  it('refuses a home-relative path rather than resolving it literally', () => {
    const root = workspace()
    expect(
      preflightNativeWorkspaceTool({
        provider: 'grok',
        toolName: 'tool',
        toolKind: 'read',
        rawToolCall: { kind: 'read', rawInput: { path: '~/.ssh/id_rsa' } },
        workspacePath: root,
        runtimeSandboxed: false
      })
    ).toMatchObject({ kind: 'deny' })
  })

  it('scopes an optional-path tool to the workspace root instead of checking nothing', () => {
    const root = workspace()
    const result = searchCall(root, { tool_name: 'Grep', pattern: 'hello', path: 'src' })
    expect(result).toMatchObject({ kind: 'allow' })
    // Never an empty list: checkedPaths is the only thing an approval card can show.
    expect('checkedPaths' in result && result.checkedPaths.length).toBeGreaterThan(0)
  })
})
