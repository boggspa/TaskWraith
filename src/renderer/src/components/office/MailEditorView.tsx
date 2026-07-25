import type { MailDocumentModel } from '../../../../shared/office/officeModels'

interface MailEditorViewProps {
  model: MailDocumentModel
  onChange: (next: MailDocumentModel) => void
}

export function MailEditorView({ model, onChange }: MailEditorViewProps) {
  const patch = (partial: Partial<MailDocumentModel>): void => {
    onChange({ ...model, ...partial })
  }

  return (
    <div className="office-mail-editor">
      <div className="office-mail-headers">
        <label className="office-field">
          <span>From</span>
          <input
            value={model.from}
            placeholder="Your Name <you@example.com>"
            onChange={(event) => patch({ from: event.target.value })}
          />
        </label>
        <label className="office-field">
          <span>To</span>
          <input
            value={model.to}
            placeholder="person@example.com, other@example.com"
            onChange={(event) => patch({ to: event.target.value })}
          />
        </label>
        <div className="office-field-row">
          <label className="office-field">
            <span>Cc</span>
            <input value={model.cc} onChange={(event) => patch({ cc: event.target.value })} />
          </label>
          <label className="office-field">
            <span>Bcc</span>
            <input value={model.bcc} onChange={(event) => patch({ bcc: event.target.value })} />
          </label>
        </div>
        <label className="office-field">
          <span>Subject</span>
          <input
            value={model.subject}
            placeholder="Subject"
            onChange={(event) => patch({ subject: event.target.value })}
          />
        </label>
      </div>
      <label className="office-field office-field-grow">
        <span>Message</span>
        <textarea
          className="office-mail-body"
          value={model.body}
          placeholder="Write the message body…"
          onChange={(event) => patch({ body: event.target.value })}
        />
      </label>
      <p className="office-muted">
        Saved as a standard .eml file — Outlook, Apple Mail and Thunderbird open it directly; Gmail
        accepts it as an attachment or draft import.
        {model.extraHeaders?.length
          ? ` ${model.extraHeaders.length} imported header${
              model.extraHeaders.length === 1 ? '' : 's'
            } preserved on save.`
          : ''}
      </p>
    </div>
  )
}
