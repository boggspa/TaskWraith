import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GREETING_AFTERNOON,
  GREETING_AFTERNOON_START_HOUR,
  GREETING_EVENING,
  GREETING_EVENING_START_HOUR,
  GREETING_MORNING,
  GREETING_PROMPT,
  buildGreeting,
  greetingForHour
} from './greeting'

describe('greetingForHour', () => {
  it('maps each band, including the boundary hours', () => {
    expect(greetingForHour(0)).toBe(GREETING_MORNING)
    expect(greetingForHour(11)).toBe(GREETING_MORNING)
    expect(greetingForHour(12)).toBe(GREETING_AFTERNOON) // boundary in
    expect(greetingForHour(17)).toBe(GREETING_AFTERNOON)
    expect(greetingForHour(18)).toBe(GREETING_EVENING) // boundary in
    expect(greetingForHour(23)).toBe(GREETING_EVENING)
  })
})

describe('buildGreeting', () => {
  it('appends a present name with the call-to-action', () => {
    expect(buildGreeting(9, 'Chris')).toBe("Good morning, What's on your mind Chris?")
    expect(buildGreeting(14, 'Chris')).toBe("Good afternoon, What's on your mind Chris?")
    expect(buildGreeting(20, 'Chris')).toBe("Good evening, What's on your mind Chris?")
  })

  it('omits empty / whitespace-only / nullish names but keeps the question', () => {
    expect(buildGreeting(9, '')).toBe("Good morning, What's on your mind?")
    expect(buildGreeting(9, '   ')).toBe("Good morning, What's on your mind?")
    expect(buildGreeting(9, null)).toBe("Good morning, What's on your mind?")
    expect(buildGreeting(9, undefined)).toBe("Good morning, What's on your mind?")
  })

  it('trims surrounding whitespace from a present name', () => {
    expect(buildGreeting(9, '  Chris  ')).toBe("Good morning, What's on your mind Chris?")
  })
})

describe('Greeting.swift drift guard', () => {
  // The iOS twin has no way to import this module, so the boundaries + strings
  // are duplicated in Greeting.swift. This guard fails CI if the two diverge
  // (same pattern as RevealParams.swift / AppIconAvailability.swift).
  const swift = readFileSync(
    join(process.cwd(), 'ios/TaskWraithKit/Sources/TaskWraithKit/Greeting.swift'),
    'utf8'
  )

  it('mirrors the band boundary hours', () => {
    const afternoon = swift.match(/afternoonStartHour\s*=\s*([0-9]+)/)
    const evening = swift.match(/eveningStartHour\s*=\s*([0-9]+)/)
    expect(afternoon, 'Greeting.swift must declare afternoonStartHour').toBeTruthy()
    expect(evening, 'Greeting.swift must declare eveningStartHour').toBeTruthy()
    expect(Number(afternoon![1])).toBe(GREETING_AFTERNOON_START_HOUR)
    expect(Number(evening![1])).toBe(GREETING_EVENING_START_HOUR)
  })

  it('mirrors the three greeting strings + the call-to-action prompt', () => {
    expect(swift).toContain(`"${GREETING_MORNING}"`)
    expect(swift).toContain(`"${GREETING_AFTERNOON}"`)
    expect(swift).toContain(`"${GREETING_EVENING}"`)
    expect(swift).toContain(`"${GREETING_PROMPT}"`)
  })
})
