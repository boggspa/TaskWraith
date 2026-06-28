import React, { useEffect, useState } from 'react'

// Resolved preview per absolute path, cached at module scope so re-renders and
// multiple tiles for the same image don't re-hit the IPC. A cached `null` means
// "couldn't decode" (unsupported format / read error) — we keep the neutral
// placeholder and never retry-storm.
const previewCache = new Map<string, string | null>()

interface ComposerImageThumbProps {
  path: string
  name: string
}

const fallbackLabelForImage = (name: string, path: string): string => {
  const value = name || path
  const match = /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(value)
  return (match?.[1] || 'IMG').slice(0, 5).toUpperCase()
}

/**
 * Thumbnail for a composer image attachment. The renderer can't show a raw
 * `file://` path (non-file origin + webSecurity blocks it — the old
 * getImagePreviewSrc route, which is why tiles fell back to a broken image), so
 * the main process reads the file via nativeImage and returns a downscaled PNG
 * data URL that an <img> can actually load.
 */
export function ComposerImageThumb({ path, name }: ComposerImageThumbProps): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(() => previewCache.get(path) ?? null)

  useEffect(() => {
    if (previewCache.has(path)) {
      setSrc(previewCache.get(path) ?? null)
      return
    }
    const read = window.api?.readImagePreview
    if (typeof read !== 'function') return
    let cancelled = false
    void read(path)
      .then((dataUrl) => {
        previewCache.set(path, dataUrl ?? null)
        if (!cancelled) setSrc(dataUrl ?? null)
      })
      .catch(() => {
        previewCache.set(path, null)
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!src) {
    // Visible placeholder while the data URL loads, or when native preview
    // decoding can't handle the user's format (common for phone-origin HEIC).
    return (
      <span
        className="composer-image-thumb composer-image-thumb-fallback"
        role="img"
        aria-label={name}
      >
        <span className="composer-image-thumb-glyph" aria-hidden="true">
          {fallbackLabelForImage(name, path)}
        </span>
      </span>
    )
  }
  return <img src={src} alt={name} className="composer-image-thumb" draggable={false} />
}
