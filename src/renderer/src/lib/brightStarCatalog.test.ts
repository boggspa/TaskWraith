import { describe, expect, it } from 'vitest'
import { BRIGHT_STARS, projectBrightStars, type ProjectedStar } from './brightStarCatalog'

const CAMBRIDGE = { lat: 52.2, lon: 0.1 }
const SYDNEY = { lat: -33.87, lon: 151.21 }

const utc = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi)

const indexOfStar = (raDeg: number, decDeg: number): number => {
  const index = BRIGHT_STARS.findIndex(
    ([ra, dec]) => Math.abs(ra - raDeg) < 0.1 && Math.abs(dec - decDeg) < 0.1
  )
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

const findProjected = (stars: ProjectedStar[], raDeg: number, decDeg: number) =>
  stars.find((star) => star.index === indexOfStar(raDeg, decDeg))

describe('projectBrightStars', () => {
  it('shows the Summer Triangle high over Cambridge on a July night, Sirius absent', () => {
    const stars = projectBrightStars(utc(2026, 7, 17, 22, 30), CAMBRIDGE.lat, CAMBRIDGE.lon)
    expect(stars.length).toBeGreaterThan(25)
    expect(stars.length).toBeLessThan(95)

    const vega = findProjected(stars, 279.23, 38.78)
    expect(vega).toBeDefined()
    // Near-zenith: the altitude compression must keep it in frame, high up.
    expect(vega!.y).toBeLessThan(25)
    expect(vega!.major).toBe(true)

    expect(findProjected(stars, 297.7, 8.87)).toBeDefined() // Altair
    expect(findProjected(stars, 310.36, 45.28)).toBeDefined() // Deneb

    // Sirius is a winter star — never in a UK July evening sky.
    expect(stars.find((star) => star.index === indexOfStar(101.29, -16.72))).toBeUndefined()
  })

  it('shows Orion and Sirius in the southern sky on a UK January evening', () => {
    const stars = projectBrightStars(utc(2026, 1, 15, 22, 0), CAMBRIDGE.lat, CAMBRIDGE.lon)

    const betelgeuse = findProjected(stars, 88.79, 7.41)
    const rigel = findProjected(stars, 78.63, -8.2)
    const alnilam = findProjected(stars, 84.05, -1.2)
    const sirius = findProjected(stars, 101.29, -16.72)
    expect(betelgeuse).toBeDefined()
    expect(rigel).toBeDefined()
    expect(alnilam).toBeDefined()
    expect(sirius).toBeDefined()

    // Southern-sky objects sit mid-panorama; Rigel below Betelgeuse.
    expect(sirius!.x).toBeGreaterThan(25)
    expect(sirius!.x).toBeLessThan(75)
    expect(rigel!.y).toBeGreaterThan(betelgeuse!.y)
    // Orion's belt is a tight trio: the three x positions span a few percent.
    const mintaka = findProjected(stars, 83.0, -0.3)
    expect(Math.abs(alnilam!.x - mintaka!.x)).toBeLessThan(3)
  })

  it('shows the Southern Cross from Sydney with east still on the left', () => {
    const stars = projectBrightStars(utc(2026, 7, 17, 9, 0), SYDNEY.lat, SYDNEY.lon)
    const acrux = findProjected(stars, 186.65, -63.1)
    const mimosa = findProjected(stars, 191.93, -59.69)
    expect(acrux).toBeDefined()
    expect(mimosa).toBeDefined()
    expect(acrux!.x).toBeGreaterThanOrEqual(0)
    expect(acrux!.x).toBeLessThanOrEqual(100)
  })

  it('sizes and brightens by magnitude', () => {
    const stars = projectBrightStars(utc(2026, 1, 15, 22, 0), CAMBRIDGE.lat, CAMBRIDGE.lon)
    const sirius = findProjected(stars, 101.29, -16.72)!
    const mintaka = findProjected(stars, 83.0, -0.3)!
    expect(sirius.sizePx).toBeGreaterThan(mintaka.sizePx)
    expect(sirius.brightness).toBeGreaterThan(mintaka.brightness)
    expect(sirius.sizePx).toBeLessThanOrEqual(4.2)
  })

  it('wheels with sidereal time', () => {
    const early = projectBrightStars(utc(2026, 1, 15, 19, 0), CAMBRIDGE.lat, CAMBRIDGE.lon)
    const later = projectBrightStars(utc(2026, 1, 15, 23, 0), CAMBRIDGE.lat, CAMBRIDGE.lon)
    const betelgeuseEarly = findProjected(early, 88.79, 7.41)!
    const betelgeuseLater = findProjected(later, 88.79, 7.41)!
    // Four hours: Orion marches noticeably westward (x increases).
    expect(betelgeuseLater.x).toBeGreaterThan(betelgeuseEarly.x + 10)
  })
})
