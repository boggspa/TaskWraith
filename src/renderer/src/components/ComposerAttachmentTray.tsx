import React from 'react'
import { FolderSymbolIcon, XSymbolIcon } from './AppChromeSymbols'
import { ComposerImageThumb } from './ComposerImageThumb'
import { FileTypeIcon } from './FileTypeIcon'
import {
  MAX_IMAGE_ATTACHMENTS,
  isDirectoryAttachment,
  isImageAttachmentPath,
  isPdfAttachmentPath,
  type ImageAttachment
} from '../lib/imageAttachments'

interface ComposerDiscordContextSelection {
  channelId: string
  channelName?: string
  limit: number
}

interface ComposerAttachmentTrayProps {
  attachments: readonly ImageAttachment[]
  discordContextSelection?: ComposerDiscordContextSelection | null
  workspacePath?: string
  onRemoveAttachment: (id: string) => void
  onClearDiscordContext: () => void
}

export function ComposerAttachmentTray({
  attachments,
  discordContextSelection,
  workspacePath,
  onRemoveAttachment,
  onClearDiscordContext
}: ComposerAttachmentTrayProps): React.JSX.Element | null {
  if (attachments.length === 0 && !discordContextSelection) return null

  const imageAttachments = attachments.filter(
    (attachment) => !isDirectoryAttachment(attachment) && isImageAttachmentPath(attachment.path)
  )
  const folderAttachments = attachments.filter(isDirectoryAttachment)
  const fileAttachments = attachments.filter(
    (attachment) => !isDirectoryAttachment(attachment) && !isImageAttachmentPath(attachment.path)
  )

  return (
    <div
      className="composer-image-strip composer-attachment-tray"
      aria-label="Composer attachments and context"
    >
      {imageAttachments.map((image) => (
        <div
          key={image.id}
          className="composer-image-item composer-image-tile is-image"
          title={image.path}
          aria-label={`Image attachment ${image.name}`}
        >
          <ComposerImageThumb path={image.path} name={image.name} />
          <AttachmentRemoveButton attachment={image} onRemove={onRemoveAttachment} />
        </div>
      ))}
      {folderAttachments.map((folder) => (
        <div
          key={folder.id}
          className="composer-image-item composer-file-card is-folder"
          title={folder.path}
          aria-label={`Folder attachment ${folder.name}`}
        >
          <span className="composer-attachment-icon" title={folder.name}>
            <FolderSymbolIcon />
          </span>
          <span className="composer-image-name" title={folder.path}>
            {folder.name}
          </span>
          <AttachmentRemoveButton attachment={folder} onRemove={onRemoveAttachment} />
        </div>
      ))}
      {fileAttachments.map((file) => {
        const isPdf = isPdfAttachmentPath(file.path)
        return (
          <div
            key={file.id}
            className={`composer-image-item composer-file-card${isPdf ? ' is-pdf' : ''}`}
            title={file.path}
          >
            <span className="composer-attachment-icon" title={file.name}>
              {isPdf ? (
                <ComposerImageThumb path={file.path} name={file.name} />
              ) : (
                <FileTypeIcon
                  path={file.path}
                  size={18}
                  className="composer-attachment-icon-inner"
                  workspacePath={workspacePath}
                />
              )}
            </span>
            <span className="composer-image-name" title={file.path}>
              {file.name}
            </span>
            <AttachmentRemoveButton attachment={file} onRemove={onRemoveAttachment} />
          </div>
        )
      })}
      {discordContextSelection && (
        <div
          className="composer-image-item composer-file-card composer-discord-context-card"
          title={`Discord #${discordContextSelection.channelName || discordContextSelection.channelId}`}
        >
          <span className="composer-discord-context-icon" aria-hidden>
            #
          </span>
          <span
            className="composer-image-name composer-discord-context-name"
            title={`Discord #${discordContextSelection.channelName || discordContextSelection.channelId}`}
          >
            {`Discord #${discordContextSelection.channelName || discordContextSelection.channelId}`}
          </span>
          <span className="composer-discord-context-count">{discordContextSelection.limit}</span>
          <button
            className="composer-image-remove"
            type="button"
            onClick={onClearDiscordContext}
            title="Remove Discord context"
            aria-label="Remove Discord context"
          >
            <XSymbolIcon />
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <span className="composer-image-count">{`${attachments.length}/${MAX_IMAGE_ATTACHMENTS}`}</span>
      )}
    </div>
  )
}

function AttachmentRemoveButton({
  attachment,
  onRemove
}: {
  attachment: ImageAttachment
  onRemove: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      className="composer-image-remove"
      type="button"
      onClick={() => onRemove(attachment.id)}
      title="Remove attachment"
      aria-label={`Remove ${attachment.name}`}
    >
      <XSymbolIcon />
    </button>
  )
}
