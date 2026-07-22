import type { JSX } from 'react'

/** Non-mutating placeholder when the Work route has no selected Project. */
export function WorkProjectReferencesEmptyShell(): JSX.Element {
  return (
    <section
      className="project-references-dock project-references-dock-empty"
      aria-label="Project references"
    >
      <header className="project-references-dock-header">
        <div>
          <span className="project-references-dock-eyebrow">Project library</span>
          <h3>References</h3>
        </div>
      </header>
      <p className="project-references-dock-empty-copy">
        Select a Project in Work to browse files, folders, links, and URLs in its reusable
        reference library.
      </p>
    </section>
  )
}
