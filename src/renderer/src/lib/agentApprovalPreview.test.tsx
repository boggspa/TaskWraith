import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  formatCanvasEvalScriptForReview,
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

  it('makes BMP and supplementary variation selectors explicit', () => {
    const script = `text\uFE0Fmore\u{E0100}end`
    const formatted = formatCanvasEvalScriptForReview(script)

    expect(formatted).toContain('⟨VARIATION SELECTOR U+FE0F⟩')
    expect(formatted).toContain('⟨VARIATION SELECTOR U+E0100⟩')
    expect(formatted).not.toContain('\uFE0F')
    expect(formatted).not.toContain('\u{E0100}')
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
})
