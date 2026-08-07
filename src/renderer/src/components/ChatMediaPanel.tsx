import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
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
import { WaveformAudioPlayer } from './WaveformAudioPlayer'
import { useCopyFeedback } from '../lib/useCopyFeedback'
import { formatBytes } from '../lib/formatBytes'
import { twMediaUrl } from '../../../shared/twMedia'
import { PillButton } from './PillButton'

export type ChatMediaSource = TranscriptMediaRef['source'] | 'external_path'
export type ChatMediaKind = 'image' | 'audio' | 'video' | 'file' | 'folder'

export interface ChatMediaRef {
  id: string
  kind: ChatMediaKind
  source: ChatMediaSource
  name: string
  path: string
  /** Workspace-relative path for `workspace_path` refs — lets the inline
   *  markdown-image resolver match `![](relative/path.png)` exactly. */
  workspaceRelativePath?: string
  mimeType?: string
  /** Content hash — builds the twmedia:// streaming URL for audio/video playback. */
  sha256?: string
  /** Duration in ms for audio/video refs — rendered as an "m:ss" badge. */
  durationMs?: number
  /** Codec descriptor for AV refs, e.g. "h264,aac" — rendered as-is in a badge. */
  codecs?: string
  /**
   * Compact waveform envelope for AUDIO refs — N integer buckets (≤512), each 0–255.
   * Drives the canvas DAW waveform (WaveformAudioPlayer normalizes by /255). Absent
   * for non-audio / older refs / oversized-skipped — the poster JPEG is the fallback.
   */
  peaks?: number[]
  /** Byte size for AV refs — rendered via formatBytes as a badge. */
  byteLength?: number
  thumbnail?: TranscriptMediaThumbnail
  status?: TranscriptMediaStatus
  alt?: string
  caption?: string
  /** Grouping hint — a contiguous run of refs sharing `groupKind` is laid out as a unit
   *  (e.g. `video_frames` → an NLE filmstrip). Mirrors TranscriptMediaRef.groupKind. */
  groupKind?: string
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

type LegacyImageThumbnail = {
  dataBase64: string
  mimeType: string
  width?: number
  height?: number
}

const normalizeLegacyThumbnail = (
  value: unknown
): LegacyImageThumbnail | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.dataBase64 !== 'string' || record.dataBase64.length === 0) {
    return undefined
  }
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : 'image/jpeg'
  return {
    dataBase64: record.dataBase64,
    mimeType,
    ...(typeof record.width === 'number' ? { width: record.width } : {}),
    ...(typeof record.height === 'number' ? { height: record.height } : {})
  }
}

export function isChatMediaImagePath(path: string): boolean {
  return /\.(png|jpe?g|jfif|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i.test(path)
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
  if (/^https?:\/\//i.test(path)) return path
  return ''
}

/** True for playable audio/video refs (rendered as <audio>/<video>, not chips). */
export function isAvMediaKind(kind: ChatMediaKind): boolean {
  return kind === 'audio' || kind === 'video'
}

/** twmedia:// playback URL for an audio/video ref, or '' when it can't be built
 * (missing content hash / unmappable mime → caller falls back to a file card). */
export function chatMediaTwUrl(ref: ChatMediaRef): string {
  return twMediaUrl(ref.sha256, ref.mimeType) || ''
}

/**
 * Humanise an AV duration (ms) to "m:ss" for the media-card badge — distinct
 * from the HH:MM:SS wall-clock `formatDuration` copies elsewhere (those format
 * elapsed run time, not a clip length). Returns '' for missing/invalid input.
 */
export function formatMediaDuration(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return ''
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Generic action item for the media-card overflow menu. Forked from
 * `SidebarOverflowMenuItem` but without the sidebar group/danger lattice —
 * media cards have a flat list (Open in Finder / Copy path / Save as).
 */
export interface MediaActionMenuItem {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
}

/**
 * Portal popover action menu for a media card. Forked from
 * `SidebarOverflowMenu`: same `createPortal`-into-body + fixed-position +
 * ESC/click-outside/arrow-key machinery, but drops the sidebar-coupled
 * right-click-on-`.sidebar-item` context-menu wiring (media cards aren't tile
 * rows). The trigger is a real `<button>` since AV/image cards are `<div>`s,
 * not buttons, so nesting is valid here.
 */
function MediaActionMenu({
  items,
  triggerLabel = 'Media actions',
  className
}: {
  items: MediaActionMenuItem[]
  triggerLabel?: string
  className?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const right = Math.max(8, window.innerWidth - rect.right)
    const top = rect.bottom + 4
    setPosition({ top, right })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const handleDocumentMouseDown = (event: globalThis.MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleScroll = (): void => setOpen(false)
    const handleResize = (): void => updatePosition()
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (open) return
    const frame = window.requestAnimationFrame(() => setFocusedIndex(-1))
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const handleItemSelect = (item: MediaActionMenuItem): void => {
    if (item.disabled) return
    setOpen(false)
    queueMicrotask(item.onSelect)
  }

  const handleTriggerClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setOpen((current) => !current)
  }

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(true)
      setFocusedIndex(0)
    }
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setFocusedIndex((index) => Math.min(items.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setFocusedIndex((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const target = items[focusedIndex]
      if (target) handleItemSelect(target)
    }
  }

  const popover =
    open && position
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            className="media-action-menu-popover sidebar-overflow-menu-popover"
            style={{ position: 'fixed', top: position.top, right: position.right, zIndex: 80 }}
            onKeyDown={handleMenuKeyDown}
          >
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`sidebar-overflow-menu-item ${focusedIndex === index ? 'is-focused' : ''}`}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleItemSelect(item)
                }}
                onMouseEnter={() => setFocusedIndex(index)}
              >
                {item.icon && (
                  <span className="sidebar-overflow-menu-item-icon" aria-hidden>
                    {item.icon}
                  </span>
                )}
                <span className="sidebar-overflow-menu-item-label">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )
      : null

  return (
    <span className={`media-action-menu ${open ? 'is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`media-action-trigger ${className || ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="sf-symbol-icon" aria-hidden>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" role="img">
            <circle cx="3.2" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="12.8" cy="8" r="1.4" />
          </svg>
        </span>
      </button>
      {popover}
    </span>
  )
}

/**
 * Build the standard media-card action menu (Open in Finder / Copy path /
 * Save as) backed by the sha-based `media-asset:*` preload bindings. Generated
 * AV refs are sha-only (no on-disk `path`), so these go through the new
 * channels rather than the path-based `revealPathInFinder`.
 *
 * NOT a hook (no React state) despite acting on a `copy` callback — kept a
 * plain builder so it can be called after an early return in the overlay.
 */
/** Host wiring for "promote this output into the Project library". Offered
 * only for path-backed refs: a promotion catalogues a locator (metadata only,
 * no access change), and sha-only transcript assets have no stable locator. */
export interface MediaPromoteToProjectLibrary {
  projectName: string
  onPromote: (ref: ChatMediaRef) => void
}

export function buildMediaCardActions(
  mediaRef: ChatMediaRef,
  copy: (id: string, text: string) => void,
  onDetachToPane?: (ref: ChatMediaRef) => void,
  promote?: MediaPromoteToProjectLibrary
): MediaActionMenuItem[] {
  const sha256 = mediaRef.sha256
  const mimeType = mediaRef.mimeType
  const canUseAssetChannels = Boolean(sha256 && mimeType)
  const canCopyImage = Boolean(
    canUseAssetChannels && mimeType && mimeType.startsWith('image/')
  )
  // "Detach to pane" only makes sense for a playable A/V ref (it pops out a
  // player) AND only when the host wired the callback (Multiview is available).
  const canDetach = Boolean(onDetachToPane && isAvMediaKind(mediaRef.kind))

  return [
    ...(canDetach
      ? [
          {
            id: 'detach-to-pane',
            label: 'Detach to pane',
            onSelect: () => onDetachToPane?.(mediaRef)
          } as MediaActionMenuItem
        ]
      : []),
    ...(canCopyImage
      ? [
          {
            id: 'copy-image',
            label: 'Copy image',
            onSelect: () => {
              if (typeof window === 'undefined' || !sha256 || !mimeType) return
              void window.api?.copyMediaAssetImage?.(sha256, mimeType)
            }
          } as MediaActionMenuItem
        ]
      : []),
    {
      id: 'reveal',
      label: 'Open in Finder',
      disabled: !canUseAssetChannels && !mediaRef.path,
      onSelect: () => {
        if (typeof window === 'undefined') return
        const api = window.api
        if (canUseAssetChannels && sha256 && mimeType) {
          void api?.revealMediaAsset?.(sha256, mimeType)
        } else if (mediaRef.path) {
          void api?.revealPathInFinder?.(mediaRef.path)
        }
      }
    },
    {
      id: 'copy-path',
      label: 'Copy path',
      disabled: !canUseAssetChannels && !mediaRef.path,
      onSelect: () => {
        if (typeof window === 'undefined') return
        const api = window.api
        if (canUseAssetChannels && sha256 && mimeType) {
          void (async () => {
            const path = await api?.getMediaAssetPath?.(sha256, mimeType)
            if (path) copy(`media-copy:${mediaRef.id}`, path)
          })()
        } else if (mediaRef.path) {
          copy(`media-copy:${mediaRef.id}`, mediaRef.path)
        }
      }
    },
    {
      id: 'save-as',
      label: mediaRef.kind === 'image' || (mimeType?.startsWith('image/') ?? false) ? 'Save image' : 'Save as',
      disabled: !canUseAssetChannels,
      onSelect: () => {
        if (typeof window === 'undefined' || !sha256 || !mimeType) return
        void window.api?.saveMediaAssetAs?.(sha256, mimeType, mediaRef.name)
      }
    },
    ...(promote && mediaRef.path
      ? [
          {
            id: 'promote-to-project-library',
            label: `Add to ${promote.projectName} library`,
            onSelect: () => promote.onPromote(mediaRef)
          } as MediaActionMenuItem
        ]
      : [])
  ]
}

/** Small muted chips under an AV card: duration / size / codec (each skipped
 * when its source field is absent). Returns null when nothing to show. */
function MediaCardBadges({ mediaRef }: { mediaRef: ChatMediaRef }): ReactNode {
  const duration = formatMediaDuration(mediaRef.durationMs)
  const size = formatBytes(mediaRef.byteLength)
  const codecs = mediaRef.codecs?.trim() || ''
  if (!duration && !size && !codecs) return null
  return (
    <div className="media-card-badges" aria-label="Media details">
      {duration && <span className="media-card-badge">{duration}</span>}
      {size && <span className="media-card-badge">{size}</span>}
      {codecs && <span className="media-card-badge">{codecs}</span>}
    </div>
  )
}

function mediaThumbnailAspectRatio(mediaRef: ChatMediaRef): string | undefined {
  const width = mediaRef.thumbnail?.width
  const height = mediaRef.thumbnail?.height
  if (!width || !height || width <= 0 || height <= 0) return undefined
  return `${width} / ${height}`
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
    const identity = ref.path
      ? `path:${ref.path}`
      : ref.sha256
        ? `sha:${ref.sha256}:${ref.mimeType || ''}`
        : ref.id
          ? `id:${ref.id}`
          : ''
    if (!identity) return
    const key = `${ref.source}:${ref.kind}:${identity}:${ref.access || ''}:${ref.status || ''}`
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

  const addLegacyImagePath = (
    value: unknown,
    index: number,
    thumbnail?: LegacyImageThumbnail
  ) => {
    const path = typeof value === 'string' ? value.trim() : ''
    if (!path) return
    addRef({
      id: `image-path:${path}`,
      kind: 'image',
      source: 'upload',
      name: chatMediaNameFromPath(path) || `Image ${index + 1}`,
      path,
      ...(thumbnail ? { mimeType: thumbnail.mimeType, thumbnail } : {})
    })
  }

  const addLegacyThumbnailOnly = (
    thumbnail: LegacyImageThumbnail,
    index: number,
    ownerId = 'chat'
  ) => {
    addRef({
      id: `image-thumbnail:${ownerId}:${index}`,
      kind: 'image',
      source: 'upload',
      name: `Image ${index + 1}`,
      path: '',
      mimeType: thumbnail.mimeType,
      thumbnail
    })
  }

  const addMediaRef = (mediaRef: TranscriptMediaRef | null | undefined) => {
    if (!mediaRef) return
    const kind = mediaRef.kind
    if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return
    const source = mediaRef.source || 'generated'
    const path = typeof mediaRef.path === 'string' ? mediaRef.path.trim() : ''
    const id = mediaRef.id || mediaRef.assetId || `${source}:${mediaRef.sha256 || mediaRef.name}`
    // Renderable if it has a path, a thumbnail, a content hash (twmedia://), or a non-available status.
    if (!id || (!path && !mediaRef.thumbnail && !mediaRef.sha256 && mediaRef.status === 'available')) return
    addRef({
      id,
      kind,
      source,
      name:
        mediaRef.name ||
        chatMediaNameFromPath(path) ||
        (kind === 'audio' ? 'Audio' : kind === 'video' ? 'Video' : 'Image'),
      path,
      ...(mediaRef.workspaceRelativePath
        ? { workspaceRelativePath: mediaRef.workspaceRelativePath }
        : {}),
      mimeType: mediaRef.mimeType,
      ...(mediaRef.sha256 ? { sha256: mediaRef.sha256 } : {}),
      ...(typeof mediaRef.durationMs === 'number' ? { durationMs: mediaRef.durationMs } : {}),
      ...(mediaRef.codecs ? { codecs: mediaRef.codecs } : {}),
      ...(Array.isArray(mediaRef.peaks) && mediaRef.peaks.length > 0 ? { peaks: mediaRef.peaks } : {}),
      ...(typeof mediaRef.byteLength === 'number' ? { byteLength: mediaRef.byteLength } : {}),
      thumbnail: mediaRef.thumbnail,
      status: mediaRef.status,
      alt: mediaRef.alt,
      caption: mediaRef.caption,
      ...(mediaRef.groupKind ? { groupKind: mediaRef.groupKind } : {})
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
    const imageThumbnails = Array.isArray(metadata.imageThumbnails)
      ? metadata.imageThumbnails.map((thumbnail: unknown) => normalizeLegacyThumbnail(thumbnail))
      : []
    const imagePaths = Array.isArray(metadata.imagePaths) ? metadata.imagePaths : []
    imagePaths.forEach((path: unknown, index: number) =>
      addLegacyImagePath(path, index, imageThumbnails[index])
    )
    if (imagePaths.length === 0) {
      imageThumbnails.forEach((thumbnail: LegacyImageThumbnail | undefined, index: number) => {
        if (thumbnail) addLegacyThumbnailOnly(thumbnail, index, message?.id || 'message')
      })
    }
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

function defaultDockMediaRef(refs: ChatMediaRef[]): ChatMediaRef | null {
  return refs.find((ref) => isAvMediaKind(ref.kind)) || refs.find((ref) => ref.kind === 'image') || refs[0] || null
}

export function collectMessageMediaRefs(message: ChatMessage): ChatMediaRef[] {
  const refs: ChatMediaRef[] = []
  const seen = new Set<string>()
  const metadata = message.metadata || {}

  const addLegacyImagePath = (
    value: unknown,
    index: number,
    thumbnail?: LegacyImageThumbnail
  ) => {
    const path = typeof value === 'string' ? value.trim() : ''
    if (!path) return
    const source = 'upload'
    const key = `${source}:${path}:`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({
      id: `image-path:${path}`,
      kind: 'image',
      source,
      name: chatMediaNameFromPath(path) || `Image ${index + 1}`,
      path,
      ...(thumbnail ? { mimeType: thumbnail.mimeType, thumbnail } : {})
    })
  }

  const addLegacyThumbnailOnly = (thumbnail: LegacyImageThumbnail, index: number) => {
    const source = 'upload'
    const id = `image-thumbnail:${message.id}:${index}`
    const key = `${source}:${id}:`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({
      id,
      kind: 'image',
      source,
      name: `Image ${index + 1}`,
      path: '',
      mimeType: thumbnail.mimeType,
      thumbnail
    })
  }

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
    if (!mediaRef) return
    const kind = mediaRef.kind
    if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return
    const path = typeof mediaRef.path === 'string' ? mediaRef.path.trim() : ''
    const source = mediaRef.source || 'generated'
    const id = mediaRef.id || mediaRef.assetId || `${source}:${mediaRef.sha256 || mediaRef.name}`
    if (!id || (!path && !mediaRef.thumbnail && !mediaRef.sha256 && mediaRef.status === 'available')) return
    const key = `${source}:${id}:${path}:${mediaRef.status || ''}`
    const pathKey = path ? `${source}:${path}:` : ''
    if (seen.has(key) || (pathKey && seen.has(pathKey))) return
    seen.add(key)
    if (pathKey) seen.add(pathKey)
    refs.push({
      id,
      kind,
      source,
      name:
        mediaRef.name ||
        chatMediaNameFromPath(path) ||
        (kind === 'audio' ? 'Audio' : kind === 'video' ? 'Video' : 'Image'),
      path,
      ...(mediaRef.workspaceRelativePath
        ? { workspaceRelativePath: mediaRef.workspaceRelativePath }
        : {}),
      mimeType: mediaRef.mimeType,
      ...(mediaRef.sha256 ? { sha256: mediaRef.sha256 } : {}),
      ...(typeof mediaRef.durationMs === 'number' ? { durationMs: mediaRef.durationMs } : {}),
      ...(mediaRef.codecs ? { codecs: mediaRef.codecs } : {}),
      ...(Array.isArray(mediaRef.peaks) && mediaRef.peaks.length > 0 ? { peaks: mediaRef.peaks } : {}),
      ...(typeof mediaRef.byteLength === 'number' ? { byteLength: mediaRef.byteLength } : {}),
      thumbnail: mediaRef.thumbnail,
      status: mediaRef.status,
      alt: mediaRef.alt,
      caption: mediaRef.caption,
      ...(mediaRef.groupKind ? { groupKind: mediaRef.groupKind } : {})
    })
  }

  const imageThumbnails = Array.isArray(metadata.imageThumbnails)
    ? metadata.imageThumbnails.map((thumbnail) => normalizeLegacyThumbnail(thumbnail))
    : []
  const imagePaths = Array.isArray(metadata.imagePaths) ? metadata.imagePaths : []
  imagePaths.forEach((path, index) => addLegacyImagePath(path, index, imageThumbnails[index]))
  if (imagePaths.length === 0) {
    imageThumbnails.forEach((thumbnail, index) => {
      if (thumbnail) addLegacyThumbnailOnly(thumbnail, index)
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
  const { copy } = useCopyFeedback()
  const [previewFailed, setPreviewFailed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    setPreviewFailed(false)
  }, [mediaRef.path, previewSrc])

  const actions = buildMediaCardActions(mediaRef, copy)
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
  const onContextMenu = (event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenuPos({ x: event.clientX, y: event.clientY })
    setMenuOpen(true)
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
    <span className="message-attachment-image-wrap" style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="message-attachment-card message-attachment-thumb is-image"
        title={title}
        aria-label={ariaLabel}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <img
          src={previewSrc}
          alt={mediaRef.name}
          loading="lazy"
          decoding="async"
          onError={() => setPreviewFailed(true)}
        />
      </button>
      {menuOpen && menuPos && (
        <ImageAttachmentContextMenu
          items={actions}
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => {
            setMenuOpen(false)
            setMenuPos(null)
          }}
        />
      )}
    </span>
  )
}

function ImageAttachmentContextMenu({
  items,
  x,
  y,
  onClose
}: {
  items: MediaActionMenuItem[]
  x: number
  y: number
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (): void => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [onClose])

  return (
    <div
      className="message-attachment-context-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 10000,
        minWidth: 160,
        padding: '4px 0',
        borderRadius: 8,
        background: 'var(--bg-elevated, #1e1e1e)',
        border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className="message-attachment-context-item"
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 12px',
            background: 'transparent',
            border: 0,
            color: 'inherit',
            cursor: item.disabled ? 'default' : 'pointer',
            opacity: item.disabled ? 0.45 : 1
          }}
          onClick={() => {
            if (item.disabled) return
            item.onSelect()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function ChatMessageAvAttachment({
  mediaRef,
  src,
  onPreviewImage,
  onDetachToPane
}: {
  mediaRef: ChatMediaRef
  src: string
  onPreviewImage?: (ref: ChatMediaRef) => void
  onDetachToPane?: (ref: ChatMediaRef) => void
}) {
  const { copy } = useCopyFeedback()
  const actions = buildMediaCardActions(mediaRef, copy, onDetachToPane)
  const expand = onPreviewImage ? () => onPreviewImage(mediaRef) : undefined
  const detach = onDetachToPane ? () => onDetachToPane(mediaRef) : undefined

  const header = (
    <div className="message-attachment-av-head">
      {expand ? (
        <button
          type="button"
          className="message-attachment-av-name-btn"
          onClick={expand}
          title={`Expand ${mediaRef.name}`}
          aria-label={`Expand ${mediaRef.name}`}
        >
          {mediaRef.name}
        </button>
      ) : (
        <span className="message-attachment-name">{mediaRef.name}</span>
      )}
      <span className="message-attachment-av-controls">
        {detach && (
          <button
            type="button"
            className="message-attachment-expand message-attachment-detach"
            onClick={detach}
            title={`Pop ${mediaRef.name} out to a pane`}
            aria-label={`Pop ${mediaRef.name} out to a pane`}
          >
            <span className="sf-symbol-icon" aria-hidden>
              {/* PiP / pop-out: a frame with an inset child rectangle + an arrow out. */}
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" role="img">
                <path d="M2 3.5h12v9H2z" strokeLinejoin="round" />
                <path d="M8 8.5h5v3H8z" fill="currentColor" stroke="none" />
                <path d="M6.5 6 10 6 10 9.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
        )}
        {expand && (
          <button
            type="button"
            className="message-attachment-expand"
            onClick={expand}
            title={`Expand ${mediaRef.name}`}
            aria-label={`Expand ${mediaRef.name}`}
          >
            <span className="sf-symbol-icon" aria-hidden>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" role="img">
                <path d="M6 2H2v4M10 14h4v-4M2 10v4h4M14 6V2h-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
        )}
        <MediaActionMenu items={actions} triggerLabel={`Actions for ${mediaRef.name}`} />
      </span>
    </div>
  )

  if (mediaRef.kind === 'audio') {
    return (
      <div className="message-attachment-card message-attachment-av is-audio" title={mediaRef.name}>
        {header}
        <MediaCardBadges mediaRef={mediaRef} />
        <WaveformAudioPlayer
          src={src}
          peaks={mediaRef.peaks}
          posterSrc={chatMediaPreviewSrc(mediaRef)}
          durationMs={mediaRef.durationMs}
          name={mediaRef.name}
        />
      </div>
    )
  }
  const poster = chatMediaPreviewSrc(mediaRef)
  const durationLabel = formatMediaDuration(mediaRef.durationMs)
  const videoFrameCount = 6
  return (
    <div className="message-attachment-card message-attachment-av is-video" title={mediaRef.name}>
      {header}
      <button
        type="button"
        className={`tw-video-clip${poster ? ' has-poster' : ' no-poster'}`}
        onClick={expand}
        disabled={!expand}
        aria-label={`Preview video ${mediaRef.name}`}
        title={expand ? `Preview ${mediaRef.name}` : mediaRef.name}
      >
        <span className="tw-video-clip-frames" aria-hidden="true">
          {Array.from({ length: videoFrameCount }).map((_, index) => (
            <span key={index} className="tw-video-clip-frame">
              {poster ? (
                <img src={poster} alt="" loading="lazy" decoding="async" />
              ) : index === 2 ? (
                <FileTypeIcon path={mediaRef.path || mediaRef.name} size={28} />
              ) : null}
            </span>
          ))}
        </span>
        <span className="tw-video-clip-play" aria-hidden="true">
          <svg viewBox="0 0 18 18" width="16" height="16" role="img">
            <path d="M6 4.2 13 9l-7 4.8z" fill="currentColor" />
          </svg>
        </span>
        <span className="tw-video-clip-label">
          <span>{mediaRef.name}</span>
          {durationLabel && <small>{durationLabel}</small>}
        </span>
      </button>
      <MediaCardBadges mediaRef={mediaRef} />
    </div>
  )
}

/** The grouping kind that renders a contiguous ref run as an NLE filmstrip. */
const FILMSTRIP_GROUP_KIND = 'video_frames'

/**
 * A horizontal NLE "filmstrip" for a run of video-frame refs (inspect_video_frames):
 * compact frame thumbnails laid out left-to-right with their timestamp caption beneath,
 * each clickable into the EXISTING lightbox (onPreviewImage) — no new overlay. Only
 * frames with a renderable preview are shown; a frame that can't be previewed falls back
 * to a standard attachment card so it is never silently dropped.
 */
function VideoFilmstrip({
  refs,
  workspacePath,
  onPreviewImage
}: {
  refs: ChatMediaRef[]
  workspacePath?: string
  onPreviewImage?: (ref: ChatMediaRef) => void
}) {
  if (refs.length === 0) return null
  return (
    <div className="tw-filmstrip" role="group" aria-label="Video frames">
      {refs.map((ref) => {
        const previewSrc = chatMediaPreviewSrc(ref)
        if (!previewSrc) {
          // No previewable surface (rare for a decoded PNG) — keep the frame visible as a
          // plain card rather than dropping it from the strip.
          return (
            <ChatMessageAttachmentCard
              key={ref.id}
              mediaRef={ref}
              workspacePath={workspacePath}
              title={onPreviewImage ? `Preview ${ref.name}` : ref.name}
              onClick={() => onPreviewImage?.(ref)}
            />
          )
        }
        const label = ref.caption || ref.name
        return (
          <button
            key={ref.id}
            type="button"
            className="tw-filmstrip-frame"
            title={onPreviewImage ? `Preview ${label}` : label}
            aria-label={`Video frame ${label}`}
            onClick={onPreviewImage ? () => onPreviewImage(ref) : undefined}
          >
            <span className="tw-filmstrip-thumb">
              <img src={previewSrc} alt={ref.caption || ref.name} loading="lazy" decoding="async" />
            </span>
            {ref.caption ? <span className="tw-filmstrip-label">{ref.caption}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Partition refs into a sequence of segments, where each MAXIMAL run of consecutive refs
 * sharing `groupKind === 'video_frames'` becomes one `filmstrip` segment and every other
 * ref is its own `single` segment. Refs arrive in emission order, so the frames of one
 * inspect_video_frames call are contiguous and group cleanly without reordering.
 */
function partitionFilmstripRuns(
  refs: ChatMediaRef[]
): Array<{ kind: 'filmstrip'; refs: ChatMediaRef[] } | { kind: 'single'; ref: ChatMediaRef }> {
  const segments: Array<
    { kind: 'filmstrip'; refs: ChatMediaRef[] } | { kind: 'single'; ref: ChatMediaRef }
  > = []
  for (const ref of refs) {
    if (ref.groupKind === FILMSTRIP_GROUP_KIND) {
      const last = segments[segments.length - 1]
      if (last && last.kind === 'filmstrip') {
        last.refs.push(ref)
      } else {
        segments.push({ kind: 'filmstrip', refs: [ref] })
      }
    } else {
      segments.push({ kind: 'single', ref })
    }
  }
  return segments
}

export function ChatMessageMediaStrip({
  refs,
  workspacePath,
  onPreviewImage,
  onDetachToPane
}: {
  refs: ChatMediaRef[]
  workspacePath?: string
  onPreviewImage?: (ref: ChatMediaRef) => void
  /** Pop an A/V ref out into its own Multiview pane (the docked media player). */
  onDetachToPane?: (ref: ChatMediaRef) => void
}) {
  const { copiedId, copy } = useCopyFeedback()
  if (refs.length === 0) return null
  const segments = partitionFilmstripRuns(refs)
  return (
    <div className="message-attachment-strip" aria-label="Message attachments">
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === 'filmstrip') {
          return (
            <VideoFilmstrip
              key={`filmstrip:${segment.refs[0].id}:${segmentIndex}`}
              refs={segment.refs}
              workspacePath={workspacePath}
              onPreviewImage={onPreviewImage}
            />
          )
        }
        const ref = segment.ref
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
        if (isAvMediaKind(ref.kind)) {
          const avSrc = chatMediaTwUrl(ref)
          if (avSrc) {
            return (
              <ChatMessageAvAttachment
                key={ref.id}
                mediaRef={ref}
                src={avSrc}
                onPreviewImage={onPreviewImage}
                onDetachToPane={onDetachToPane}
              />
            )
          }
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
  onClose,
  onDetachToPane
}: {
  mediaRef: ChatMediaRef | null
  workspacePath?: string
  onClose: () => void
  /** Pop the A/V ref out into its own Multiview pane (closes the lightbox). */
  onDetachToPane?: (ref: ChatMediaRef) => void
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

  const isAv = isAvMediaKind(mediaRef.kind)
  const avSrc = isAv ? chatMediaTwUrl(mediaRef) : ''
  const previewSrc = mediaRef.kind === 'image' ? chatMediaPreviewSrc(mediaRef) : ''
  const poster = mediaRef.kind === 'video' ? chatMediaPreviewSrc(mediaRef) : ''
  const copyId = `preview:${mediaRef.id}`
  const isCopied = copiedId === copyId
  const location = formatChatMediaLocation(mediaRef.path, workspacePath)
  const closePreviewLabel =
    mediaRef.kind === 'audio'
      ? 'Close audio preview'
      : mediaRef.kind === 'video'
        ? 'Close video preview'
        : 'Close image preview'

  const openPath = (): void => {
    if (!mediaRef.path) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    void api?.openExternalOrPath?.(mediaRef.path)
  }

  // Sha-based asset actions (Open in Finder / Copy path / Save as) — the only
  // way to act on a generated, path-less AV ref from inside the lightbox.
  const assetActions = buildMediaCardActions(mediaRef, copy, onDetachToPane)
  const hasAssetChannels = Boolean(mediaRef.sha256 && mediaRef.mimeType)
  const canDetach = Boolean(onDetachToPane && isAv)

  return (
    <div
      className="chat-media-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="chat-media-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-media-preview-title"
      >
        <header className="chat-media-preview-header">
          <div className="chat-media-preview-title">
            <span id="chat-media-preview-title">{mediaRef.name}</span>
            <small>{location}</small>
          </div>
          <button
            className="chat-media-preview-close"
            type="button"
            onClick={onClose}
            aria-label={closePreviewLabel}
          >
            <XSymbolIcon />
          </button>
        </header>

        <div className="chat-media-preview-body">
          {isAv && avSrc ? (
            <div className="chat-media-preview-av">
              {mediaRef.kind === 'audio' ? (
                <WaveformAudioPlayer
                  src={avSrc}
                  peaks={mediaRef.peaks}
                  posterSrc={chatMediaPreviewSrc(mediaRef)}
                  durationMs={mediaRef.durationMs}
                  name={mediaRef.name}
                />
              ) : (
                <video controls autoPlay preload="metadata" {...(poster ? { poster } : {})} src={avSrc} />
              )}
              <MediaCardBadges mediaRef={mediaRef} />
            </div>
          ) : previewSrc && !previewFailed ? (
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
          {canDetach && (
            <PillButton
              size="compact"
              onClick={() => {
                onDetachToPane?.(mediaRef)
                onClose()
              }}
            >
              Detach to pane
            </PillButton>
          )}
          {hasAssetChannels && (
            <MediaActionMenu
              items={assetActions}
              triggerLabel={`Actions for ${mediaRef.name}`}
              className="chat-media-preview-action-menu"
            />
          )}
          {mediaRef.path && (
            <PillButton size="compact" onClick={() => copy(copyId, mediaRef.path)}>
              {isCopied ? 'Copied' : 'Copy path'}
            </PillButton>
          )}
          {mediaRef.path && (
            <PillButton size="compact" onClick={openPath}>
              Open file
            </PillButton>
          )}
          <PillButton size="compact" onClick={onClose}>
            Close
          </PillButton>
        </footer>
      </section>
    </div>
  )
}

function DockVideoPreview({
  mediaRef,
  src,
  poster
}: {
  mediaRef: ChatMediaRef
  src: string
  poster?: string
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [aspectRatio, setAspectRatio] = useState<string | undefined>(() =>
    mediaThumbnailAspectRatio(mediaRef)
  )

  useEffect(() => {
    setAspectRatio(mediaThumbnailAspectRatio(mediaRef))
  }, [mediaRef.id, mediaRef.thumbnail?.width, mediaRef.thumbnail?.height])

  return (
    <div
      className="right-dock-media-video-frame"
      style={aspectRatio ? { aspectRatio } : undefined}
    >
      <video
        ref={videoRef}
        controls
        preload="metadata"
        {...(poster ? { poster } : {})}
        src={src}
        onLoadedMetadata={() => {
          const video = videoRef.current
          if (!video?.videoWidth || !video.videoHeight) return
          setAspectRatio(`${video.videoWidth} / ${video.videoHeight}`)
        }}
      />
    </div>
  )
}

function ChatMediaDockPreview({
  mediaRef,
  workspacePath,
  onPreviewImage,
  onDetachToPane,
  promoteToProjectLibrary,
  copy
}: {
  mediaRef: ChatMediaRef
  workspacePath?: string
  onPreviewImage?: (ref: ChatMediaRef) => void
  onDetachToPane?: (ref: ChatMediaRef) => void
  promoteToProjectLibrary?: MediaPromoteToProjectLibrary
  copy: (id: string, text: string) => void
}) {
  const isAv = isAvMediaKind(mediaRef.kind)
  const avSrc = isAv ? chatMediaTwUrl(mediaRef) : ''
  const previewSrc = chatMediaPreviewSrc(mediaRef)
  const location = formatChatMediaLocation(mediaRef.path, workspacePath)
  const actions = buildMediaCardActions(mediaRef, copy, onDetachToPane, promoteToProjectLibrary)

  return (
    <section className={`right-dock-media-preview kind-${mediaRef.kind}`} aria-label="Selected media">
      <div className="right-dock-media-preview-top">
        <div className="right-dock-media-preview-title">
          <strong title={mediaRef.name}>{mediaRef.name}</strong>
          <small title={location}>{location}</small>
        </div>
        <MediaActionMenu items={actions} triggerLabel={`Actions for ${mediaRef.name}`} />
      </div>

      <div className="right-dock-media-preview-body">
        {isAv && avSrc ? (
          mediaRef.kind === 'audio' ? (
            <WaveformAudioPlayer
              src={avSrc}
              peaks={mediaRef.peaks}
              posterSrc={previewSrc}
              durationMs={mediaRef.durationMs}
              name={mediaRef.name}
            />
          ) : (
            <DockVideoPreview mediaRef={mediaRef} src={avSrc} poster={previewSrc || undefined} />
          )
        ) : mediaRef.kind === 'image' && previewSrc ? (
          <button
            type="button"
            className="right-dock-media-image-preview"
            onClick={() => onPreviewImage?.(mediaRef)}
            disabled={!onPreviewImage}
            aria-label={`Preview image ${mediaRef.name}`}
          >
            <img src={previewSrc} alt={mediaRef.name} loading="lazy" decoding="async" />
          </button>
        ) : (
          <div className="right-dock-media-file-preview">
            <FileTypeIcon path={mediaRef.path || mediaRef.name} size={36} workspacePath={workspacePath} />
            <span>{mediaRef.name}</span>
          </div>
        )}
      </div>

      <div className="right-dock-media-preview-meta">
        <MediaCardBadges mediaRef={mediaRef} />
        {isAv && onDetachToPane && (
          <button
            type="button"
            className="right-dock-media-detach"
            onClick={() => onDetachToPane(mediaRef)}
          >
            Detach
          </button>
        )}
      </div>
    </section>
  )
}

function ChatMediaDockRow({
  mediaRef,
  workspacePath,
  selected,
  isCopied,
  onSelect
}: {
  mediaRef: ChatMediaRef
  workspacePath?: string
  selected: boolean
  isCopied: boolean
  onSelect: () => void
}) {
  const previewSrc = chatMediaPreviewSrc(mediaRef)
  const location = formatChatMediaLocation(mediaRef.path, workspacePath)
  return (
    <button
      type="button"
      className={`right-dock-media-item kind-${mediaRef.kind}${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      title={mediaRef.path || mediaRef.name}
      aria-pressed={selected}
    >
      <span className="right-dock-media-thumb" aria-hidden="true">
        {previewSrc && (mediaRef.kind === 'image' || mediaRef.kind === 'video' || mediaRef.kind === 'audio') ? (
          <img src={previewSrc} alt="" loading="lazy" decoding="async" />
        ) : (
          <FileTypeIcon path={mediaRef.path || mediaRef.name} size={18} workspacePath={workspacePath} />
        )}
      </span>
      <span>
        <strong>{mediaRef.name}</strong>
        <small>{isCopied ? 'Copied' : location}</small>
      </span>
      {mediaRef.access && <em>{mediaRef.access}</em>}
    </button>
  )
}

export function ChatMediaDockPanel({
  refs,
  workspacePath,
  onClose,
  onPreviewImage,
  onDetachToPane,
  promoteToProjectLibrary
}: {
  refs: ChatMediaRef[]
  workspacePath?: string
  onClose: () => void
  onPreviewImage?: (ref: ChatMediaRef) => void
  onDetachToPane?: (ref: ChatMediaRef) => void
  promoteToProjectLibrary?: MediaPromoteToProjectLibrary
}) {
  const { copiedId, copy } = useCopyFeedback()
  const [selectedId, setSelectedId] = useState(() => defaultDockMediaRef(refs)?.id || '')
  const explicitSelectedRef = refs.find((ref) => ref.id === selectedId) || null
  const selectedRef = explicitSelectedRef || defaultDockMediaRef(refs)

  useEffect(() => {
    if (refs.length === 0) {
      setSelectedId('')
      return
    }
    if (explicitSelectedRef) return
    setSelectedId(defaultDockMediaRef(refs)?.id || '')
  }, [refs, explicitSelectedRef])

  return (
    <div className="right-dock-media-panel">
      <header className="right-dock-panel-header">
        <div>
          <span className="right-dock-kicker">Media</span>
          <strong>Uploads and paths</strong>
        </div>
        <button
          type="button"
          className="segmented-control-action segmented-control-action--compact"
          onClick={onClose}
        >
          Close
        </button>
      </header>

      {refs.length === 0 || !selectedRef ? (
        <div className="right-dock-empty">No uploads or external paths on this chat.</div>
      ) : (
        <div className="right-dock-media-content">
          <ChatMediaDockPreview
            mediaRef={selectedRef}
            workspacePath={workspacePath}
            onPreviewImage={onPreviewImage}
            onDetachToPane={onDetachToPane}
            promoteToProjectLibrary={promoteToProjectLibrary}
            copy={copy}
          />
          <div className="right-dock-media-list" aria-label="Chat media items">
            {refs.map((mediaRef) => (
              <ChatMediaDockRow
                key={mediaRef.id}
                mediaRef={mediaRef}
                workspacePath={workspacePath}
                selected={mediaRef.id === selectedRef.id}
                isCopied={copiedId === mediaRef.id}
                onSelect={() => setSelectedId(mediaRef.id)}
              />
            ))}
          </div>
        </div>
      )}
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
  const avRefs = refs.filter((ref) => isAvMediaKind(ref.kind))
  const fileRefs = refs.filter((ref) => ref.kind === 'file' || ref.kind === 'folder')

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

          {avRefs.length > 0 && (
            <div className="chat-media-section">
              <div className="chat-media-section-title">Audio and video</div>
              <div className="chat-media-av-list">
                {avRefs.map((ref) => {
                  const src = chatMediaTwUrl(ref)
                  const poster = ref.kind === 'video' ? chatMediaPreviewSrc(ref) : ''
                  const actions = buildMediaCardActions(ref, copy)
                  return (
                    <div key={ref.id} className={`chat-media-av-item is-${ref.kind}`}>
                      <div className="chat-media-av-head">
                        <div className="chat-media-av-name">{ref.name}</div>
                        <MediaActionMenu items={actions} triggerLabel={`Actions for ${ref.name}`} />
                      </div>
                      {src ? (
                        ref.kind === 'audio' ? (
                          <WaveformAudioPlayer
                            src={src}
                            peaks={ref.peaks}
                            posterSrc={chatMediaPreviewSrc(ref)}
                            durationMs={ref.durationMs}
                            name={ref.name}
                          />
                        ) : (
                          <video controls preload="metadata" {...(poster ? { poster } : {})} src={src} />
                        )
                      ) : (
                        <span className="chat-media-file-fallback">
                          <FileTypeIcon path={ref.path} size={22} workspacePath={workspacePath} />
                        </span>
                      )}
                      <MediaCardBadges mediaRef={ref} />
                    </div>
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
