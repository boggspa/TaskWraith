import { useEffect, useMemo, useState } from 'react'
import { DigitOdometer } from './DigitOdometer'
import { MOTION_DURATIONS, usePresence } from '../hooks/usePanelPresence'
import { extractHttpUrls, type LinkPresentationTarget } from '../lib/urlPresentation'
import { FaviconImage, useFaviconForUrl } from './FaviconImage'

interface ComposerLinkPreviewStripProps {
  text: string
}

export function ComposerLinkPreviewStrip({ text }: ComposerLinkPreviewStripProps) {
  const links = useMemo(() => extractHttpUrls(text, 5), [text])
  const [displayedLinks, setDisplayedLinks] = useState(links)
  const presence = usePresence(links.length > 0, {
    durationMs: MOTION_DURATIONS.base,
    variant: 'rise'
  })

  // Preserve the last chips through the exit window, then swap immediately
  // when the composer gains a new URL. The animation is at strip level only.
  useEffect(() => {
    if (links.length > 0) setDisplayedLinks(links)
  }, [links])

  if (!presence.mounted) return null
  const visible = displayedLinks.slice(0, 4)
  const hiddenCount = displayedLinks.length - visible.length

  return (
    <div
      className={`composer-link-preview-strip${presence.className ? ` ${presence.className}` : ''}`}
      aria-label="Link previews"
    >
      {visible.map((target) => (
        <ComposerLinkPreviewChip key={target.url} target={target} />
      ))}
      {hiddenCount > 0 && (
        <span className="composer-link-preview-more" role="img" aria-label={`${hiddenCount} more links`}>
          <span aria-hidden>
            <DigitOdometer value={hiddenCount} sign="+" />
          </span>
        </span>
      )}
    </div>
  )
}

function ComposerLinkPreviewChip({ target }: { target: LinkPresentationTarget }) {
  const favicon = useFaviconForUrl(target.url)
  const label = favicon?.ok && favicon.title ? favicon.title : target.host

  return (
    <span className="composer-link-preview-chip" title={target.url}>
      <FaviconImage url={target.url} host={target.host} size={14} />
      <span className="composer-link-preview-host">{target.host}</span>
      {label && label !== target.host && <span className="composer-link-preview-title">{label}</span>}
    </span>
  )
}
