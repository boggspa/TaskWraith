import { useMemo } from 'react'
import type { WordDocumentModel } from '../../../../shared/office/officeModels'
import { wordModelToHtml } from '../../../../shared/office/wordHtml'

interface WordEditorViewProps {
  model: WordDocumentModel
  /**
   * Identity of the loaded document revision. The contentEditable surface is
   * uncontrolled while typing; it only re-renders from the model when this
   * key changes (open/reload), never on keystrokes or saves.
   */
  docKey: string
  onHtmlChange: (html: string) => void
}

interface ToolbarCommand {
  id: string
  label: string
  title: string
  command: string
  value?: string
}

const INLINE_COMMANDS: ToolbarCommand[] = [
  { id: 'bold', label: 'B', title: 'Bold', command: 'bold' },
  { id: 'italic', label: 'I', title: 'Italic', command: 'italic' },
  { id: 'underline', label: 'U', title: 'Underline', command: 'underline' },
  { id: 'strike', label: 'S', title: 'Strikethrough', command: 'strikeThrough' }
]

const LIST_COMMANDS: ToolbarCommand[] = [
  { id: 'bullets', label: '• List', title: 'Bulleted list', command: 'insertUnorderedList' },
  { id: 'numbers', label: '1. List', title: 'Numbered list', command: 'insertOrderedList' }
]

const exec = (command: string, value?: string): void => {
  document.execCommand(command, false, value)
}

export function WordEditorView({ model, docKey, onHtmlChange }: WordEditorViewProps) {
  // Only regenerate the mounted HTML when the document revision changes;
  // regenerating per keystroke would clobber the caret.
  const initialHtml = useMemo(
    () => wordModelToHtml(model),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docKey]
  )

  const runCommand = (command: string, value?: string): void => {
    exec(command, value)
    const surface = document.querySelector<HTMLElement>(`[data-office-word="${docKey}"]`)
    if (surface) onHtmlChange(surface.innerHTML)
  }

  return (
    <div className="office-word-editor">
      <div className="office-editor-toolbar" role="toolbar" aria-label="Text formatting">
        <select
          className="office-toolbar-select"
          aria-label="Paragraph style"
          value=""
          onChange={(event) => {
            if (event.target.value) runCommand('formatBlock', event.target.value)
          }}
        >
          <option value="" disabled>
            Style
          </option>
          <option value="<p>">Paragraph</option>
          <option value="<h1>">Heading 1</option>
          <option value="<h2>">Heading 2</option>
          <option value="<h3>">Heading 3</option>
        </select>
        {INLINE_COMMANDS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`office-toolbar-button office-toolbar-${entry.id}`}
            title={entry.title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand(entry.command, entry.value)}
          >
            {entry.label}
          </button>
        ))}
        <span className="office-toolbar-divider" aria-hidden="true" />
        {LIST_COMMANDS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="office-toolbar-button"
            title={entry.title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand(entry.command, entry.value)}
          >
            {entry.label}
          </button>
        ))}
        <span className="office-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="office-toolbar-button"
          title="Insert link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const url = window.prompt('Link URL (https://…)')
            if (url && /^https?:\/\//i.test(url)) runCommand('createLink', url)
          }}
        >
          Link
        </button>
        <button
          type="button"
          className="office-toolbar-button"
          title="Clear formatting"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => runCommand('removeFormat')}
        >
          Clear
        </button>
      </div>
      <div
        key={docKey}
        data-office-word={docKey}
        className="office-word-surface"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Document body"
        spellCheck
        onInput={(event) => onHtmlChange(event.currentTarget.innerHTML)}
        dangerouslySetInnerHTML={{ __html: initialHtml }}
      />
    </div>
  )
}
