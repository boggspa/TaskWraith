const formatApprovalChangePreview = (changes: any): string => {
  if (!Array.isArray(changes) || changes.length === 0) return ''
  return changes
    .map((change) => {
      const kind = String(change?.kind || change?.type || change?.operation || 'update')
      const filePath = String(
        change?.path || change?.filePath || change?.file_path || change?.target || ''
      )
      const additions = Number(change?.additions || change?.added || 0)
      const deletions = Number(change?.deletions || change?.deleted || 0)
      const stats = additions || deletions ? ' (+' + additions + ' -' + deletions + ')' : ''
      return (kind + (filePath ? ' ' + filePath : '') + stats).trim()
    })
    .filter(Boolean)
    .join('\\n')
}

const formatLaunchContextPreview = (preview: any): string => {
  if (preview?.kind !== 'launch-target') return ''
  const lines: string[] = []
  const add = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text) lines.push(`${label}: ${text}`)
  }
  add('Target', preview.label)
  add('Source', preview.source)
  add('Kind', preview.kindLabel)
  add('Platform', preview.platform)
  add('Execution', preview.execution)
  if (preview.shell === true) lines.push('Shell: yes')
  else if (preview.shell === false) lines.push('Shell: no')
  const git = preview.git && typeof preview.git === 'object' ? preview.git : null
  if (git) {
    const branch = typeof git.branch === 'string' ? git.branch.trim() : ''
    const head = typeof git.head === 'string' ? git.head.trim() : ''
    if (branch) lines.push(`Branch: ${branch}`)
    else if (git.detached && head) lines.push(`Branch: detached ${head.slice(0, 7)}`)
    else if (git.detached) lines.push('Branch: detached HEAD')
  }
  return lines.join('\n')
}

export const isCanvasEvalApprovalToolName = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase().replace(/-/g, '_')
  return normalized === 'canvas_eval' || /(?:^|_)canvas_eval$/.test(normalized)
}

const namedInvisibleCodePoints = new Map<number, string>([
  [0x00a0, 'NBSP'],
  [0x00ad, 'SOFT HYPHEN'],
  [0x034f, 'COMBINING GRAPHEME JOINER'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE']
])

const visibleCodePoint = (character: string): string => {
  const codePoint = character.codePointAt(0) ?? 0
  // Marker delimiters and the line-prefix separator are visible characters,
  // but leaving them literal makes the review rendering non-injective: a real
  // tab and the literal text `⟨TAB U+0009⟩` would look identical. Escape the
  // review grammar itself so no script can counterfeit a control marker or a
  // generated line prefix.
  const reviewGrammarName =
    codePoint === 0x27e8
      ? 'LITERAL LEFT ANGLE BRACKET'
      : codePoint === 0x27e9
        ? 'LITERAL RIGHT ANGLE BRACKET'
        : codePoint === 0x2502
          ? 'LITERAL BOX DRAWINGS LIGHT VERTICAL'
          : undefined
  const controlName =
    character === '\t'
      ? 'TAB'
      : character === '\r'
        ? 'CR'
        : character === '\n'
          ? 'LF'
          : namedInvisibleCodePoints.get(codePoint)
  const isControl = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
  const isUnpairedSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff
  const isVariationSelector =
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  if (
    !reviewGrammarName &&
    !controlName &&
    !isControl &&
    !isUnpairedSurrogate &&
    !isVariationSelector
  ) {
    return character
  }
  const label =
    reviewGrammarName ||
    controlName ||
    (isUnpairedSurrogate
      ? 'UNPAIRED SURROGATE'
      : isVariationSelector
        ? 'VARIATION SELECTOR'
        : 'CONTROL')
  return `\u27e8${label} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}\u27e9`
}

/** One-to-one, line-numbered rendering that makes bidi/zero-width/control code points visible. */
export const formatCanvasEvalScriptForReview = (script: string): string => {
  let line = 1
  let output = `${line.toString().padStart(4, ' ')} \u2502 `
  for (const character of script) {
    output += visibleCodePoint(character)
    if (character === '\n') {
      output += '\n'
      line += 1
      output += `${line.toString().padStart(4, ' ')} \u2502 `
    }
  }
  return output
}

const canvasEvalScriptFromPreview = (value: unknown, depth = 0): string => {
  if (depth > 6) return ''
  if (typeof value === 'string') {
    if (value.length > 200_000 || !value.trim().startsWith('{')) return ''
    try {
      return canvasEvalScriptFromPreview(JSON.parse(value), depth + 1)
    } catch {
      return ''
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const script = canvasEvalScriptFromPreview(child, depth + 1)
      if (script) return script
    }
    return ''
  }
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.script === 'string') return record.script
  for (const child of Object.values(record)) {
    const script = canvasEvalScriptFromPreview(child, depth + 1)
    if (script) return script
  }
  return ''
}

const renderAgentApprovalPreview = (preview: any): React.JSX.Element | null => {
  if (!preview || typeof preview !== 'object') return null
  const command = typeof preview.command === 'string' ? preview.command : ''
  const cwd = typeof preview.cwd === 'string' ? preview.cwd : ''
  const toolName = typeof preview.toolName === 'string' ? preview.toolName : ''
  const requiresCanvasEvalExactReview =
    preview.requiresExactDesktopReview === true || isCanvasEvalApprovalToolName(toolName)
  const canvasEvalScript = requiresCanvasEvalExactReview
    ? canvasEvalScriptFromPreview(preview.params)
    : ''
  const canvasEvalReceipt =
    preview.canvasEvalReceipt && typeof preview.canvasEvalReceipt === 'object'
      ? preview.canvasEvalReceipt
      : null
  const canvasEvalReview = canvasEvalScript
    ? formatCanvasEvalScriptForReview(canvasEvalScript)
    : ''
  const taskPreview = typeof preview.task === 'string' ? preview.task : ''
  const patchPreview =
    typeof preview.patchPreview === 'string'
      ? preview.patchPreview
      : typeof preview.diff === 'string'
        ? preview.diff
        : typeof preview.patch === 'string'
          ? preview.patch
          : ''
  const changesPreview = formatApprovalChangePreview(preview.changes)
  const riskLabels = Array.isArray(preview.riskLabels)
    ? preview.riskLabels.map((label: unknown) => String(label).trim()).filter(Boolean)
    : []
  const envDeltas =
    preview.envDeltas && typeof preview.envDeltas === 'object' && !Array.isArray(preview.envDeltas)
      ? Object.entries(preview.envDeltas)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join('\n')
      : ''
  const kind = typeof preview.kind === 'string' ? preview.kind : 'approval'
  const launchContextPreview = formatLaunchContextPreview(preview)
  // Outlook drafts: WHO receives this is the fact the approval turns on, so it
  // gets its own rows rather than living inside the grey prompt paragraph. The
  // main process normalizes recipients with the same parser the write uses, so
  // these rows cannot disagree with what is created.
  const mailFields = (() => {
    if (!toolName.startsWith('outlook_')) return null
    const params =
      preview.params && typeof preview.params === 'object' && !Array.isArray(preview.params)
        ? (preview.params as Record<string, unknown>)
        : null
    if (!params) return null
    const addresses = (value: unknown): string =>
      Array.isArray(value)
        ? value.map((entry) => String(entry)).join(', ')
        : typeof value === 'string'
          ? value
          : ''
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    const fields = {
      to: addresses(params.to),
      cc: addresses(params.cc),
      subject: text(params.subject),
      body: text(params.body)
    }
    const isDraft = toolName === 'outlook_create_draft'
    if (!isDraft && !fields.to && !fields.cc && !fields.subject && !fields.body) return null
    return { ...fields, isDraft }
  })()
  const hasDetails =
    command ||
    cwd ||
    toolName ||
    canvasEvalScript ||
    launchContextPreview ||
    taskPreview ||
    patchPreview ||
    changesPreview ||
    riskLabels.length ||
    envDeltas
  if (!hasDetails) return null

  return (
    <div className="agent-approval-preview">
      <div className="agent-approval-preview-header">{kind}</div>
      {toolName && (
        <div className="agent-approval-preview-row">
          <span>Tool</span>
          <code>{toolName}</code>
        </div>
      )}
      {cwd && (
        <div className="agent-approval-preview-row">
          <span>Cwd</span>
          <code>{cwd}</code>
        </div>
      )}
      {command && (
        <div className="agent-approval-preview-block">
          <span>Command</span>
          <pre>{command}</pre>
        </div>
      )}
      {canvasEvalScript && (
        <div className="agent-approval-preview-block canvas-eval-exact-review">
          <span>JavaScript to execute (control-visible exact review)</span>
          <div className="canvas-eval-review-metadata">
            UTF-16: {String(canvasEvalReceipt?.scriptLength ?? canvasEvalScript.length)} code units
            {' \u00b7 '}UTF-8: {String(canvasEvalReceipt?.scriptByteLength ?? 'receipt pending')} bytes
            {typeof canvasEvalReceipt?.scriptHash === 'string' && (
              <>{' \u00b7 '}SHA-256: {canvasEvalReceipt.scriptHash}</>
            )}
          </div>
          <pre dir="ltr">{canvasEvalReview}</pre>
          <small>
            Angle-bracket tokens are literal invisible/control characters in the script that will
            execute.
          </small>
        </div>
      )}
      {launchContextPreview && (
        <div className="agent-approval-preview-block">
          <span>Launch context</span>
          <pre>{launchContextPreview}</pre>
        </div>
      )}
      {mailFields && (mailFields.isDraft || mailFields.to) && (
        <div className="agent-approval-preview-row">
          <span>To</span>
          {/* Stated rather than hidden: a draft with no recipients is a fact
            worth seeing, not a row that quietly disappears. */}
          <code>{mailFields.to || '(no recipients)'}</code>
        </div>
      )}
      {mailFields?.cc && (
        <div className="agent-approval-preview-row">
          <span>Cc</span>
          <code>{mailFields.cc}</code>
        </div>
      )}
      {mailFields?.subject && (
        <div className="agent-approval-preview-row">
          <span>Subject</span>
          <code>{mailFields.subject}</code>
        </div>
      )}
      {mailFields?.body && (
        <div className="agent-approval-preview-block">
          <span>Message</span>
          <pre>{mailFields.body}</pre>
        </div>
      )}
      {riskLabels.length > 0 && (
        <div className="agent-approval-preview-row">
          <span>Risk</span>
          <code>{riskLabels.join(', ')}</code>
        </div>
      )}
      {envDeltas && (
        <div className="agent-approval-preview-block">
          <span>Env deltas</span>
          <pre>{envDeltas}</pre>
        </div>
      )}
      {taskPreview && (
        <div className="agent-approval-preview-block">
          <span>Task</span>
          <pre>{taskPreview}</pre>
        </div>
      )}
      {changesPreview && (
        <div className="agent-approval-preview-block">
          <span>Files</span>
          <pre>{changesPreview}</pre>
        </div>
      )}
      {patchPreview && (
        <div className="agent-approval-preview-block">
          <span>Diff preview</span>
          <pre>{patchPreview}</pre>
        </div>
      )}
    </div>
  )
}

export { formatApprovalChangePreview, renderAgentApprovalPreview }
