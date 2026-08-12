import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerAttachmentTray } from './ComposerAttachmentTray'

describe('ComposerAttachmentTray', () => {
  it('renders a folder reference as a folder card without an image preview', () => {
    const html = renderToStaticMarkup(
      <ComposerAttachmentTray
        attachments={[
          {
            id: 'folder-1',
            path: '/tmp/reference-package',
            name: 'reference-package',
            kind: 'directory'
          }
        ]}
        onRemoveAttachment={() => {}}
        onClearDiscordContext={() => {}}
      />
    )

    expect(html).toContain('composer-file-card is-folder')
    expect(html).toContain('aria-label="Folder attachment reference-package"')
    expect(html).toContain('reference-package')
    expect(html).toContain('1/15')
    expect(html).not.toContain('<img')
  })
})
