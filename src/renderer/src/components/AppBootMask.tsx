import taskwraithGhostMonolineSvg from '../assets/taskwraith-ghost-monoline.svg?raw'

interface AppBootMaskProps {
  leaving: boolean
}

export function AppBootMask({ leaving }: AppBootMaskProps) {
  return (
    <div
      className={`app-boot-mask ${leaving ? 'is-leaving' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
      aria-label="Loading TaskWraith"
    >
      <div className="app-boot-brand">
        <span
          className="app-boot-ghost"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: taskwraithGhostMonolineSvg }}
        />
        <span className="app-boot-wordmark">TaskWraith</span>
      </div>
    </div>
  )
}
