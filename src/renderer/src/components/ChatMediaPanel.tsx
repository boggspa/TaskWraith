import { useEffect, useState } from 'react'
import type {
  ChatRecord,
  ChatMessage,
  ExternalPathGrant,
  TranscriptMediaRef,
  TranscriptMediaStatus,
  TranscriptMediaThumbnail
} from '../../../main/store/types'
import { collectExternalPathGrantsFromMetadata } from '../../../main/store/ExternalPathGrants'
import { XSymbolIcon } from './AppChromeSymbols'
import { FileTypeIcon } from './FileTypeIcon'
import { useCopyFeedback } from '../lib/useCopyFeedback'

export type ChatMediaSource = TranscriptMediaRef['source'] | 'external_path'
export type ChatMediaKind = 'image' | 'file' | 'folder'

export interface ChatMediaRef {
  id: string
  kind: ChatMediaKind
  source: ChatMediaSource
  name: string
  path: string
  mimeType?: string
  thumbnail?: TranscriptMediaThumbnail
  status?: TranscriptMediaStatus
  alt?: string
  caption?: string
  access?: ExternalPathGrant['access']
}

export type MediaAttachmentLike = {
  id?: string
  path?: string
  name?: string
  kind?: ChatMediaKind
  source?: ChatMediaSource
  access?: ExternalPathGrant['access']
  mimeType?: string
  thumbnail?: TranscriptMediaThumbnail
  status?: TranscriptMediaStatus
  alt?: string
  caption?: string
}

export function isChatMediaImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg)$/i.test(path)
}

export function chatMediaNameFromPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  if (!trimmed) return 'Untitled'
  return trimmed.split('/').pop() || trimmed
}

export function chatMediaPreviewSrc(mediaRef: ChatMediaRef): string {
  const thumbnail = mediaRef.thumbnail
  if (thumbnail?.dataBase64 && /^image\/(png|jpe?g|webp)$/i.test(thumbnail.mimeType || '')) {
    return `data:${thumbnail.mimeType};base64,${thumbnail.dataBase64}`
  }
  const path = mediaRef.path
  if (!path) return ''
  if (mediaRef.source !== 'upload' && mediaRef.source !== 'external_path') return ''
  if (/^(file|https?):\/\//i.test(path)) return path
  if (!path.startsWith('/')) return ''
  return `file://${encodeURI(path)}`
}

export function formatChatMediaLocation(path: string, workspacePath?: string): string {
  if (!path) return 'Transcript media'
  if (workspacePath && path.startsWith(`${workspacePath}/`)) {
    return path.slice(workspacePath.length + 1)
  }
  return path
}

export function collectChatMediaRefs(
  chat: ChatRecord | null,
  pendingImages: MediaAttachmentLike[],
  currentExternalPathGrants: ExternalPathGrant[]
): ChatMediaRef[] {
  const refs: ChatMediaRef[] = []
  const seen = new Set<string>()

  const addRef = (ref: ChatMediaRef) => {
    if (!ref.path) return
    const key = `${ref.source}:${ref.path}:${ref.access || ''}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push(ref)
  }

  const addAttachment = (
    attachment: MediaAttachmentLike | null | undefined,
    source: ChatMediaSource = 'upload'
  ) => {
    const path = typeof attachment?.path === 'string' ? attachment.path.trim() : ''
    if (!path) return
    addRef({
      id: attachment?.id || `${source}:${path}`,
      kind: isChatMediaImagePath(path) ? 'image' : 'file',
      source,
      name: attachment?.name || chatMediaNameFromPath(path),
      path
    })
  }

  const addMediaRef = (mediaRef: TranscriptMediaRef | null | undefined) => {
    if (!mediaRef || mediaRef.kind !== 'image') return
    const source = mediaRef.source || 'generated'
    const path = typeof mediaRef.path === 'string' ? mediaRef.path.trim() : ''
    const id = mediaRef.id || mediaRef.assetId || `${source}:${mediaRef.sha256 || mediaRef.name}`
    if (!id || (!path && !mediaRef.thumbnail && mediaRef.status === 'available')) return
    addRef({
      id,
      kind: 'image',
      source,
      name: mediaRef.name || chatMediaNameFromPath(path) || 'Image',
      path,
      mimeType: mediaRef.mimeType,
      thumbnail: mediaRef.thumbnail,
      status: mediaRef.status,
      alt: mediaRef.alt,
      caption: mediaRef.caption
    })
  }

  const addGrant = (grant: Partial<ExternalPathGrant> | null | undefined) => {
    const path = typeof grant?.path === 'string' ? grant.path.trim() : ''
    if (!path) return
    const grantKind = grant?.kind
    const grantAccess = grant?.access
    const kind =
      grantKind === 'directory' ? 'folder' : isChatMediaImagePath(path) ? 'image' : 'file'
    addRef({
      id: grant?.id || `external_path:${path}:${grantAccess || 'read'}`,
      kind,
      source: 'external_path',
      name: chatMediaNameFromPath(path),
      path,
      access: grantAccess
    })
  }

  pendingImages.forEach((attachment) => addAttachment(attachment))
  currentExternalPathGrants.forEach((grant) => addGrant(grant))

  const chatAny = chat as any
  collectExternalPathGrantsFromMetadata(chatAny?.providerMetadata).forEach((grant) =>
    addGrant(grant)
  )

  const messages = Array.isArray(chatAny?.messages) ? chatAny.messages : []
  messages.forEach((message: any) => {
    const metadata = message?.metadata || {}
    ;[metadata.imageAttachments, metadata.attachments].forEach((candidate) => {
      if (Array.isArray(candidate)) {
        candidate.forEach((attachment) => addAttachment(attachment))
      }
    })
    if (Array.isArray(metadata.mediaRefs)) {
      metadata.mediaRefs.forEach((mediaRef) => addMediaRef(mediaRef as TranscriptMediaRef))
    }
  })

  const runs = Array.isArray(chatAny?.runs) ? chatAny.runs : []
  runs.forEach((run: any) => {
    ;[
      run,
      run?.request,
      run?.snapshot,
      run?.requestSnapshot,
      run?.runRequest,
      run?.payload
    ].forEach((candidate) => {
      if (!candidate) return
      if (Array.isArray(candidate.imageAttachments)) {
        candidate.imageAttachments.forEach((attachment: MediaAttachmentLike) =>
          addAttachment(attachment)
        )
      }
      if (Array.isArray(candidate.attachments)) {
        candidate.attachments.forEach((attachment: MediaAttachmentLike) =>
          addAttachment(attachment)
        )
      }
      if (Array.isArray(candidate.externalPathGrants)) {
        candidate.externalPathGrants.forEach((grant: Partial<ExternalPathGrant>) => addGrant(grant))
      }
    })
  })

  return refs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => {
      const rank = (ref: ChatMediaRef) =>
        ref.kind === 'image' ? 0 : ref.kind === 'folder' ? 1 : 2
      return rank(a.ref) - rank(b.ref) || a.index - b.index
    })
    .map(({ ref }) => ref)
}

export function collectMessageMediaRefs(message: ChatMessage): ChatMediaRef[] {
  const refs: ChatMediaRef[] = []
  const seen = new Set<string>()
  const metadata = message.metadata || {}

  const addAttachment = (attachment: MediaAttachmentLike | null | undefined) => {
    const path = typeof attachment?.path === 'string' ? attachment.path.trim() : ''
    if (!path) return
    const source = attachment?.source === 'external_path' ? 'external_path' : 'upload'
    const key = `${source}:${path}:${attachment?.access || ''}`
    if (seen.has(key)) return
    seen.add(key)
    const declaredKind = attachment?.kind
    const kind =
      declaredKind === 'folder' || declaredKind === 'file' || declaredKind === 'image'
        ? declaredKind
        : isChatMediaImagePath(path)
          ? 'image'
          : 'file'
    refs.push({
      id: attachment?.id || `${source}:${path}`,
      kind,
      source,
      name: attachment?.name || chatMediaNameFromPath(path),
      path,
      ...(attachment?.access ? { access: attachment.access } : {})
    })
  }

  const addMediaRef = (mediaRef: TranscriptMediaRef | null | undefined) => {
    if (!mediaRef || mediaRef.kind !== 'image') return
    const path = typeof mediaRef.path === 'string' ? mediaRef.path.trim() : ''
    const source = mediaRef.source || 'generated'
    const id = mediaRef.id || mediaRef.assetId || `${source}:${mediaRef.sha256 || mediaRef.name}`
    if (!id || (!path && !mediaRef.thumbnail && mediaRef.status === 'available')) return
    const key = `${source}:${id}:${path}:${mediaRef.status || ''}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({
      id,
      kind: 'image',
      source,
      name: mediaRef.name || chatMediaNameFromPath(path) || 'Image',
      path,
      mimeType: mediaRef.mimeType,
      thumbnail: mediaRef.thumbnail,
      status: mediaRef.status,
      alt: mediaRef.alt,
      caption: mediaRef.caption
    })
  }

  ;[metadata.imageAttachments, metadata.attachments].forEach((candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((attachment) => addAttachment(attachment as MediaAttachmentLike))
    }
  })
  if (Array.isArray(metadata.mediaRefs)) {
    metadata.mediaRefs.forEach((mediaRef) => addMediaRef(mediaRef as TranscriptMediaRef))
  }

  return refs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => {
      const rank = (ref: ChatMediaRef) =>
        ref.kind === 'image' ? 0 : ref.kind === 'folder' ? 1 : 2
      return rank(a.ref) - rank(b.ref) || a.index - b.index
    })
    .map(({ ref }) => ref)
}

function chatMediaStatusLabel(status?: TranscriptMediaStatus): string {
  switch (status) {
    case 'unsafe_svg':
      return 'SVG preview disabled'
    case 'too_large':
      return 'Image too large'
    case 'denied':
      return 'Preview denied'
    case 'missing':
      return 'Image missing'
    case 'unsupported':
      return 'Unsupported image'
    default:
      return ''
  }
}

function ChatMessageAttachmentCard({
  mediaRef,
  workspacePath,
  title,
  ariaLabel,
  isCopied,
  onClick
}: {
  mediaRef: ChatMediaRef
  workspacePath?: string
  title: string
  ariaLabel?: string
  isCopied?: boolean
  onClick: () => void
}) {
  const visualKind = mediaRef.kind === 'folder' ? 'folder' : 'file'
  const statusLabel = chatMediaStatusLabel(mediaRef.status)
  return (
    <button
      type="button"
      className={`message-attachment-card is-${visualKind}${
        mediaRef.kind === 'image' ? ' is-image-fallback' : ''
      }`}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <span className="message-attachment-icon">
        <FileTypeIcon path={mediaRef.path} size={16} workspacePath={workspacePath} />
      </span>
      <span className="message-attachment-copy">
        <span className="message-attachment-name">{mediaRef.name}</span>
        <span className="message-attachment-path">
          {isCopied ? 'Copied' : statusLabel || formatChatMediaLocation(mediaRef.path, workspacePath)}
        </span>
      </span>
    </button>
  )
}

function ChatMessageImageAttachment({
  mediaRef,
  previewSrc,
  workspacePath,
  isCopied,
  onPreviewImage,
  onCopy
}: {
  mediaRef: ChatMediaRef
  previewSrc: string
  workspacePath?: string
  isCopied: boolean
  onPreviewImage?: (ref: ChatMediaRef) => void
  onCopy: () => void
}) {
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => {
    setPreviewFailed(false)
  }, [mediaRef.path, previewSrc])

  const statusLabel = chatMediaStatusLabel(mediaRef.status)
  const title = statusLabel
    ? `${mediaRef.name}: ${statusLabel}`
    : onPreviewImage
    ? `Preview ${mediaRef.name}`
    : isCopied
      ? 'Copied'
      : `Copy ${mediaRef.name} path`
  const ariaLabel = statusLabel
    ? `${mediaRef.name}: ${statusLabel}`
    : onPreviewImage
    ? `Preview image ${mediaRef.name}`
    : `Copy ${mediaRef.name} path`
  const onClick = (): void => {
    if (onPreviewImage) {
      onPreviewImage(mediaRef)
    } else {
      onCopy()
    }
  }

  if (!previewSrc || previewFailed) {
    return (
      <ChatMessageAttachmentCard
        mediaRef={mediaRef}
        workspacePath={workspacePath}
        title={title}
        ariaLabel={ariaLabel}
        isCopied={!onPreviewImage && isCopied}
        onClick={onClick}
      />
    )
  }

  return (
    <button
      type="button"
      className="message-attachment-card message-attachment-thumb is-image"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <img
        src={previewSrc}
        alt={mediaRef.name}
        loading="lazy"
        decoding="async"
        onError={() => setPreviewFailed(true)}
      />
    </button>
  )
}

export function ChatMessageMediaStrip({
  refs,
  workspacePath,
  onPreviewImage
}: {
  refs: ChatMediaRef[]
  workspacePath?: string
  onPreviewImage?: (ref: ChatMediaRef) => void
}) {
  const { copiedId, copy } = useCopyFeedback()
  if (refs.length === 0) return null
  return (
    <div className="message-attachment-strip" aria-label="Message attachments">
      {refs.map((ref) => {
        const previewSrc = ref.kind === 'image' ? chatMediaPreviewSrc(ref) : ''
        const isCopied = copiedId === ref.id
        if (ref.kind === 'image') {
          return (
            <ChatMessageImageAttachment
              key={ref.id}
              mediaRef={ref}
              previewSrc={previewSrc}
              workspacePath={workspacePath}
              isCopied={isCopied}
              onPreviewImage={onPreviewImage}
              onCopy={() => copy(ref.id, ref.path)}
            />
          )
        }
        return (
          <ChatMessageAttachmentCard
            key={ref.id}
            mediaRef={ref}
            workspacePath={workspacePath}
            title={isCopied ? 'Copied' : `Copy ${ref.name} path`}
            isCopied={isCopied}
            onClick={() => copy(ref.id, ref.path)}
          />
        )
      })}
    </div>
  )
}

export function ChatMediaPreviewOverlay({
  mediaRef,
  workspacePath,
  onClose
}: {
  mediaRef: ChatMediaRef | null
  workspacePath?: string
  onClose: () => void
}) {
  const { copiedId, copy } = useCopyFeedback()
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    if (!mediaRef) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mediaRef, onClose])

  useEffect(() => {
    setPreviewFailed(false)
  }, [mediaRef?.id, mediaRef?.path])

  if (!mediaRef) return null

  const previewSrc = mediaRef.kind === 'image' ? chatMediaPreviewSrc(mediaRef) : ''
  const copyId = `preview:${mediaRef.id}`
  const isCopied = copiedId === copyId
  const location = formatChatMediaLocation(mediaRef.path, workspacePath)

  const openPath = (): void => {
    if (!mediaRef.path) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    void api?.openExternalOrPath?.(mediaRef.path)
  }

  return (
    <div
      className="chat-media-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="chat-media-preview-dialog" role="dialog" aria-modal="true">
        <header className="chat-media-preview-header">
          <div className="chat-media-preview-title">
            <span>{mediaRef.name}</span>
            <small>{location}</small>
          </div>
          <button
            className="chat-media-preview-close"
            type="button"
            onClick={onClose}
            aria-label="Close image preview"
          >
            <XSymbolIcon />
          </button>
        </header>

        <div className="chat-media-preview-body">
          {previewSrc && !previewFailed ? (
            <img
              src={previewSrc}
              alt={mediaRef.name}
              decoding="async"
              onError={() => setPreviewFailed(true)}
            />
          ) : (
            <div className="chat-media-preview-fallback">
              <FileTypeIcon path={mediaRef.path} size={42} workspacePath={workspacePath} />
              <span className="chat-media-preview-fallback-name">{mediaRef.name}</span>
              <small>{location}</small>
            </div>
          )}
        </div>

        <footer className="chat-media-preview-actions">
          {mediaRef.path && (
            <button type="button" className="btn btn-sm" onClick={() => copy(copyId, mediaRef.path)}>
              {isCopied ? 'Copied' : 'Copy path'}
            </button>
          )}
          {mediaRef.path && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={openPath}>
              Open file
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  )
}

export function ChatMediaFloatingPanel({
  open,
  refs,
  workspacePath,
  onClose
}: {
  open: boolean
  refs: ChatMediaRef[]
  workspacePath?: string
  onClose: () => void
}) {
  const { copiedId, copy } = useCopyFeedback()
  if (!open) return null

  const imageRefs = refs.filter((ref) => ref.kind === 'image')
  const fileRefs = refs.filter((ref) => ref.kind !== 'image')

  return (
    <section className="chat-media-panel" aria-label="Chat media and files">
      <header className="chat-media-panel-header">
        <div>
          <div className="chat-media-panel-kicker">Chat media</div>
          <h2>Uploads and paths</h2>
        </div>
        <button
          className="chat-media-panel-close"
          type="button"
          onClick={onClose}
          aria-label="Close chat media panel"
        >
          <XSymbolIcon />
        </button>
      </header>

      {refs.length === 0 ? (
        <div className="chat-media-empty">
          Explicitly uploaded images and granted file paths for this chat will appear here.
        </div>
      ) : (
        <>
          {imageRefs.length > 0 && (
            <div className="chat-media-section">
              <div className="chat-media-section-title">Images</div>
              <div className="chat-media-image-grid">
                {imageRefs.map((ref) => {
                  const previewSrc = chatMediaPreviewSrc(ref)
                  const isCopied = copiedId === ref.id
                  return (
                    <button
                      key={ref.id}
                      className="chat-media-image-card"
                      type="button"
                      title={isCopied ? 'Copied' : ref.path}
                      onClick={() => copy(ref.id, ref.path)}
                    >
                      {previewSrc ? (
                        <img src={previewSrc} alt={ref.name} />
                      ) : (
                        <span className="chat-media-file-fallback">
                          <FileTypeIcon path={ref.path} size={22} workspacePath={workspacePath} />
                        </span>
                      )}
                      <span>{isCopied ? 'Copied' : ref.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {fileRefs.length > 0 && (
            <div className="chat-media-section">
              <div className="chat-media-section-title">Files and paths</div>
              <div className="chat-media-file-list">
                {fileRefs.map((ref) => {
                  const isCopied = copiedId === ref.id
                  return (
                    <button
                      key={ref.id}
                      className="chat-media-file-row"
                      type="button"
                      title={isCopied ? 'Copied' : 'Copy path'}
                      onClick={() => copy(ref.id, ref.path)}
                    >
                      <span className="chat-media-file-icon">
                        <FileTypeIcon path={ref.path} size={18} workspacePath={workspacePath} />
                      </span>
                      <span className="chat-media-file-copy">
                        <span className="chat-media-file-name">{ref.name}</span>
                        <span className="chat-media-file-path">
                          {isCopied ? 'Copied' : formatChatMediaLocation(ref.path, workspacePath)}
                        </span>
                      </span>
                      <span className={`chat-media-source source-${ref.source}`}>
                        {ref.source === 'external_path' ? ref.access || 'path' : 'upload'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
