import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FirstLaunchSheet } from './FirstLaunchSheet'
import { FIRST_RUN_ENSEMBLE_TASK_ID } from '../lib/firstRunEnsembleTask'

describe('FirstLaunchSheet first-run Ensemble task', () => {
  it('mounts the canned task in the Ensemble onboarding section', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
      />
    )

    expect(html).toContain(`data-first-run-ensemble-task="${FIRST_RUN_ENSEMBLE_TASK_ID}"`)
    expect(html).toContain('Try this first: a governed workspace review')
    expect(html).toContain('Suggested safe setup')
  })
})
