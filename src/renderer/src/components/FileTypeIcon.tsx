import { useEffect, useMemo, useState } from 'react'
import { getFileBaseName, getFileTypeMeta, type FileTypeMeta } from './FileTypeIconModel'

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)
}
const removeRelativeDotPrefix = (value: string): string =>
  value.replace(/^\.\//, '').replace(/^\.\\/, '')
const joinWorkspacePath = (workspacePath: string, relPath: string): string => {
  if (!workspacePath) {
    return relPath
  }
  const base = workspacePath.replace(/[\\/]+$/, '')
  const rel = removeRelativeDotPrefix(relPath).replace(/^[\\/]+/, '')
  return `${base}/${rel}`
}

const iconUrlCache = new Map<string, string | null>()
const iconUrlInFlight = new Map<string, Promise<string | null>>()

const loadFileIconFromPath = async (filePath: string): Promise<string | null> => {
  const cached = iconUrlCache.get(filePath)
  if (cached !== undefined) {
    return cached
  }
  if (iconUrlInFlight.has(filePath)) {
    return iconUrlInFlight.get(filePath) as Promise<string | null>
  }

  const request =
    typeof window.api.getFileIconDataUrl === 'function'
      ? window.api.getFileIconDataUrl(filePath)
      : Promise.resolve(null)

  const payload = request
    .then((dataUrl) => {
      if (typeof dataUrl === 'string' && dataUrl.length > 0) {
        return dataUrl
      }
      return null
    })
    .catch(() => null)
    .then((resolved) => {
      iconUrlInFlight.delete(filePath)
      iconUrlCache.set(filePath, resolved)
      return resolved
    })

  iconUrlInFlight.set(filePath, payload)
  return payload
}

const getIconPathCandidates = (value: string, workspacePath?: string): string[] => {
  const path = value.trim()
  if (!path) {
    return []
  }
  if (!workspacePath || isAbsolutePath(path)) {
    return [path]
  }

  const candidates = new Set<string>([path])
  const relativeCandidate = joinWorkspacePath(workspacePath, path)
  if (relativeCandidate && relativeCandidate !== path) {
    candidates.add(relativeCandidate)
  }
  const strippedCandidate = joinWorkspacePath(workspacePath, removeRelativeDotPrefix(path))
  if (strippedCandidate && strippedCandidate !== relativeCandidate && strippedCandidate !== path) {
    candidates.add(strippedCandidate)
  }
  return Array.from(candidates)
}

function FileTypeLogo({ kind }: { kind: FileTypeMeta['kind'] }) {
  switch (kind) {
    case 'swift':
      return (
        <svg className="file-type-icon-logo-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M20.7 15.2c.1-.3.2-.6.2-.9 0-4.4-5.2-9.1-10.3-11.9 2.3 3.2 4.8 7 5.8 9.6-2.6-2.5-6.1-5.3-9.9-7.4 1.2 1.8 2.9 4 4.7 6-1.5-.9-3.5-1.8-5.8-2.6 2.7 3 5.9 5.5 8.8 7-2.2 1.2-5.4 1.4-9.6.4 3 3.1 6.8 4.9 10.1 4.5 1.5-.2 2.6-.8 3.5-1.7.8.4 1.6 1.1 2.4 2.1.4-1.6.4-2.9.1-4.1z"
          />
        </svg>
      )
    case 'metal':
      return (
        <svg className="file-type-icon-logo-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M4.3 18.8 6.4 5.2h3.1l2.6 7.1 2.6-7.1h3.1l2 13.6h-3.2l-.9-7.2-2.5 7.2H11l-2.6-7.2-.9 7.2H4.3z"
          />
          <path
            fill="currentColor"
            opacity=".58"
            d="M6.4 5.2h3.1l2.6 7.1-1.1 3.1L8.4 8.2 7.5 18.8H4.3L6.4 5.2z"
          />
        </svg>
      )
    case 'python':
      return (
        <svg className="file-type-icon-logo-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 3.1c-3.6 0-5.4.9-5.4 2.8v3.3h5.8v1.3H5.2c-1.7 0-2.9 1.4-2.9 3.4 0 2.1 1.1 3.5 2.9 3.5h2.2v-3c0-2 1.6-3.5 3.8-3.5h5.4c1.6 0 2.8-1.3 2.8-3V5.9c0-1.8-1.8-2.8-5.3-2.8H12zm-2.9 2c.6 0 1 .4 1 1s-.4 1-1 1-1-.4-1-1 .4-1 1-1z"
          />
          <path
            fill="currentColor"
            opacity=".62"
            d="M11.8 20.9c3.6 0 5.4-.9 5.4-2.8v-3.3h-5.8v-1.3h7.2c1.7 0 2.9-1.4 2.9-3.4 0-2.1-1.1-3.5-2.9-3.5h-2.2v3c0 2-1.6 3.5-3.8 3.5H7.2c-1.6 0-2.8 1.3-2.8 3v2c0 1.8 1.8 2.8 5.3 2.8h2.1zm2.9-2c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"
          />
        </svg>
      )
    case 'shell':
      return <span className="file-type-icon-logo-text">$</span>
    case 'cpp':
      return <span className="file-type-icon-logo-text file-type-icon-logo-text-cpp">C++</span>
    case 'c':
      return <span className="file-type-icon-logo-text">C</span>
    case 'cocoa':
      return (
        <svg className="file-type-icon-logo-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4l8-4.6zm0 3.2L6.8 9v6l5.2 3 5.2-3V9L12 6zm0 2.4 3.1 1.8v3.6L12 15.6l-3.1-1.8v-3.6L12 8.4z"
          />
        </svg>
      )
    default:
      return <span className="file-type-icon-glyph">F</span>
  }
}

interface FileTypeIconProps {
  path: string
  isDirectory?: boolean
  size?: number
  className?: string
  workspacePath?: string
}

export function FileTypeIcon({
  path,
  isDirectory = false,
  size = 14,
  className = '',
  workspacePath
}: FileTypeIconProps) {
  const meta = getFileTypeMeta(path)
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const candidates = useMemo(
    () => getIconPathCandidates(path, workspacePath),
    [path, workspacePath]
  )
  const usesNativeIcon = !isDirectory && meta.kind === 'generic'

  useEffect(() => {
    let cancelled = false
    const resetIcon = (): void => {
      queueMicrotask(() => {
        if (!cancelled) setIconUrl(null)
      })
    }

    if (!usesNativeIcon) {
      resetIcon()
      return () => {
        cancelled = true
      }
    }
    if (candidates.length === 0) {
      resetIcon()
      return () => {
        cancelled = true
      }
    }

    resetIcon()

    const load = async () => {
      for (const candidate of candidates) {
        const nextIcon = await loadFileIconFromPath(candidate)
        if (cancelled) {
          return
        }
        if (nextIcon) {
          setIconUrl(nextIcon)
          return
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [candidates, usesNativeIcon])

  if (isDirectory) {
    const folderName = getFileBaseName(path)
    return (
      <span
        className={`file-type-icon file-type-icon-folder ${className}`.trim()}
        style={{
          width: size,
          height: size,
          minWidth: size,
          minHeight: size,
          fontSize: Math.max(9, Math.round(size * 0.57))
        }}
        title={`Folder${folderName ? ` • ${folderName}` : ''}`}
        aria-label="Folder icon"
      >
        <svg className="file-type-icon-folder-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            opacity=".72"
            d="M3.7 6.6c0-1 .8-1.8 1.8-1.8h4.4c.6 0 1.2.3 1.5.8l.9 1.2h6.2c1 0 1.8.8 1.8 1.8v1.2H3.7V6.6z"
          />
          <path
            fill="currentColor"
            d="M3.7 9.2h16.6v8.2c0 1-.8 1.8-1.8 1.8h-13c-1 0-1.8-.8-1.8-1.8V9.2z"
          />
        </svg>
      </span>
    )
  }

  return (
    <span
      className={`file-type-icon ${iconUrl ? 'file-type-icon-native' : `file-type-icon-${meta.kind}`} ${!usesNativeIcon ? 'file-type-icon-logo' : ''} ${className}`.trim()}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        fontSize: Math.max(9, Math.round(size * 0.57))
      }}
      title={`${meta.label} file${path ? ` • ${getFileBaseName(path)}` : ''}`}
      aria-label={`${meta.label} file icon`}
    >
      {iconUrl ? (
        <img className="file-type-icon-image" src={iconUrl} alt={`${meta.label} icon`} />
      ) : !usesNativeIcon ? (
        <FileTypeLogo kind={meta.kind} />
      ) : (
        <span className="file-type-icon-glyph">{meta.glyph}</span>
      )}
    </span>
  )
}
