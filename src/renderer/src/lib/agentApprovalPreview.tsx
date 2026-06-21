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

const renderAgentApprovalPreview = (preview: any): React.JSX.Element | null => {
  if (!preview || typeof preview !== 'object') return null
  const command = typeof preview.command === 'string' ? preview.command : ''
  const cwd = typeof preview.cwd === 'string' ? preview.cwd : ''
  const toolName = typeof preview.toolName === 'string' ? preview.toolName : ''
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
  const hasDetails =
    command ||
    cwd ||
    toolName ||
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
      {launchContextPreview && (
        <div className="agent-approval-preview-block">
          <span>Launch context</span>
          <pre>{launchContextPreview}</pre>
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
