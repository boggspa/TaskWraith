import { describe, expect, it } from 'vitest'
import { derivePlanTitle, parseProposedPlan, stripProposedPlanBlock } from './proposedPlan'

describe('parseProposedPlan', () => {
  it('extracts an explicit <proposed_plan> block even outside plan mode', () => {
    const text = `Sure, here is the plan:\n\n<proposed_plan>\n# Add A Spooky Joke Smoke Test\n\n## Summary\nAdd one small Python file.\n</proposed_plan>\n\nLet me know.`
    const plan = parseProposedPlan(text, false)
    expect(plan).not.toBeNull()
    expect(plan?.title).toBe('Add A Spooky Joke Smoke Test')
    expect(plan?.body).toContain('## Summary')
    expect(plan?.body).not.toContain('Sure, here is the plan')
  })

  it('returns null for a plain turn when NOT in plan mode (no block)', () => {
    expect(parseProposedPlan('Here is a long-ish answer with several sentences that runs well past the substantive threshold so length alone would otherwise qualify it as a plan body.', false)).toBeNull()
  })

  it('treats a substantive plan-mode turn (heading) as the plan', () => {
    const plan = parseProposedPlan('## Plan\n\n- Step one\n- Step two', true)
    expect(plan?.title).toBe('Plan')
    expect(plan?.body).toContain('Step one')
  })

  it('treats a plan-mode turn with multiple list items as the plan', () => {
    const plan = parseProposedPlan('I will:\n- create the file\n- add the tests\n- run them', true)
    expect(plan).not.toBeNull()
    expect(plan?.title).toBe('I will:')
  })

  it('ignores a one-line acknowledgement in plan mode', () => {
    expect(parseProposedPlan('Okay, sounds good.', true)).toBeNull()
  })

  it('ignores long plan-mode narration with no heading or steps (no over-trigger)', () => {
    expect(
      parseProposedPlan(
        'I explored the code and read the README plus a couple of the test files to understand the existing conventions before deciding what to change.',
        true
      )
    ).toBeNull()
  })

  it('ignores a lone recap heading in plan mode (single heading, no body)', () => {
    expect(parseProposedPlan('## Summary', true)).toBeNull()
    expect(parseProposedPlan('### Done', true)).toBeNull()
  })

  it('ignores a single heading with only a trivial body in plan mode', () => {
    expect(parseProposedPlan('## Notes\n\nLooks fine.', true)).toBeNull()
  })

  it('still surfaces a single heading carrying a substantial prose body', () => {
    const plan = parseProposedPlan(
      '# Refactor the auth flow\n\nI will extract the token validation into a shared helper, update the three call sites, and add a focused unit test for it.',
      true
    )
    expect(plan).not.toBeNull()
    expect(plan?.title).toBe('Refactor the auth flow')
  })

  it('still surfaces a single heading that carries at least one step', () => {
    const plan = parseProposedPlan('## Plan\n- do the one thing', true)
    expect(plan).not.toBeNull()
    expect(plan?.title).toBe('Plan')
  })

  it('surfaces a multi-section plan even with terse section bodies', () => {
    const plan = parseProposedPlan('## Step 1\nDo the thing\n## Step 2\nDo the other thing', true)
    expect(plan).not.toBeNull()
    expect(plan?.title).toBe('Step 1')
  })

  it('returns null for an empty block', () => {
    expect(parseProposedPlan('<proposed_plan>\n\n</proposed_plan>', true)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseProposedPlan('', true)).toBeNull()
  })
})

describe('derivePlanTitle', () => {
  it('prefers the first markdown heading', () => {
    expect(derivePlanTitle('# Refactor the auth flow\n\nbody')).toBe('Refactor the auth flow')
  })

  it('falls back to the first non-empty line, stripping a bullet', () => {
    expect(derivePlanTitle('- First bullet item\n- second')).toBe('First bullet item')
  })

  it('truncates very long titles', () => {
    const long = `# ${'x'.repeat(120)}`
    expect(derivePlanTitle(long).endsWith('…')).toBe(true)
    expect(derivePlanTitle(long).length).toBeLessThanOrEqual(80)
  })

  it('defaults when there is no usable line', () => {
    expect(derivePlanTitle('   \n  \n')).toBe('Proposed plan')
  })
})

describe('stripProposedPlanBlock', () => {
  it('removes the block so the card is the only plan surface', () => {
    expect(stripProposedPlanBlock('intro\n<proposed_plan>body</proposed_plan>\noutro')).toBe(
      'intro\n\noutro'
    )
  })

  it('leaves a block-free message untouched', () => {
    expect(stripProposedPlanBlock('just a normal message')).toBe('just a normal message')
  })

  it('strips EVERY block, not just the first', () => {
    expect(
      stripProposedPlanBlock('a<proposed_plan>X</proposed_plan>b<proposed_plan>Y</proposed_plan>c')
    ).toBe('abc')
  })
})
