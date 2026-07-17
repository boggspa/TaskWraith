/**
 * The real night sky for the transcript backdrop: the ~120 brightest stars
 * (complete to visual magnitude ≈ 2.5, plus fainter members that finish
 * famous asterisms — the Dipper's Megrez, Orion's head, Cassiopeia's ε…),
 * projected each scene tick from J2000 equatorial coordinates onto the
 * layer's south-facing panorama via local sidereal time. Constellations are
 * genuinely recognisable and wheel through the night at the sidereal rate.
 *
 * Coordinates are J2000 (RA in degrees = hours × 15, Dec in degrees,
 * visual magnitude); precession since J2000 (~0.4°) is invisible at this
 * scale. Data: classic bright-star catalog values, public domain.
 */

import { equatorialToHorizontal } from '../../../shared/skyAstronomy'

type CatalogStar = [raDeg: number, decDeg: number, magnitude: number]

// prettier-ignore
export const BRIGHT_STARS: CatalogStar[] = [
  // — Ursa Minor
  [37.95, 89.26, 1.98],    // Polaris
  [222.68, 74.16, 2.08],   // Kochab
  [230.18, 71.83, 3.05],   // Pherkad
  // — Ursa Major (the Plough)
  [165.93, 61.75, 1.79],   // Dubhe
  [165.46, 56.38, 2.37],   // Merak
  [178.46, 53.69, 2.44],   // Phecda
  [183.86, 57.03, 3.31],   // Megrez
  [193.51, 55.96, 1.77],   // Alioth
  [200.98, 54.93, 2.27],   // Mizar
  [206.89, 49.31, 1.86],   // Alkaid
  // — Cassiopeia
  [10.13, 56.54, 2.24],    // Schedar
  [2.29, 59.15, 2.27],     // Caph
  [14.18, 60.72, 2.47],    // γ Cas
  [21.45, 60.24, 2.68],    // Ruchbah
  [28.6, 63.67, 3.38],     // Segin
  // — Cepheus / Draco
  [319.64, 62.59, 2.46],   // Alderamin
  [269.15, 51.49, 2.23],   // Eltanin
  [262.6, 52.3, 2.79],     // Rastaban
  [245.99, 61.51, 2.74],   // η Dra
  // — Lyra / Cygnus / Aquila (Summer Triangle)
  [279.23, 38.78, 0.03],   // Vega
  [284.74, 32.69, 3.24],   // Sulafat
  [282.52, 33.36, 3.52],   // Sheliak
  [310.36, 45.28, 1.25],   // Deneb
  [305.56, 40.26, 2.23],   // Sadr
  [311.55, 33.97, 2.48],   // Gienah Cygni
  [296.24, 45.13, 2.87],   // δ Cyg
  [292.68, 27.96, 3.05],   // Albireo
  [297.7, 8.87, 0.76],     // Altair
  [296.56, 10.61, 2.72],   // Tarazed
  // — Hercules / Boötes / Corona Borealis
  [247.55, 21.49, 2.78],   // Kornephoros
  [250.32, 31.6, 2.81],    // ζ Her
  [213.92, 19.18, -0.05],  // Arcturus
  [221.25, 27.07, 2.37],   // Izar
  [208.67, 18.4, 2.68],    // Muphrid
  [233.67, 26.71, 2.22],   // Alphecca
  // — Virgo / Leo
  [201.3, -11.16, 0.98],   // Spica
  [195.54, 10.96, 2.85],   // Vindemiatrix
  [152.09, 11.97, 1.36],   // Regulus
  [177.26, 14.57, 2.14],   // Denebola
  [154.99, 19.84, 2.37],   // Algieba
  [168.53, 20.52, 2.56],   // Zosma
  // — Gemini / Auriga
  [116.33, 28.03, 1.14],   // Pollux
  [113.65, 31.89, 1.62],   // Castor
  [99.43, 16.4, 1.92],     // Alhena
  [95.74, 22.51, 2.87],    // Tejat
  [79.17, 46.0, 0.08],     // Capella
  [89.88, 44.95, 1.9],     // Menkalinan
  [74.25, 33.17, 2.69],    // Hassaleh
  // — Taurus
  [68.98, 16.51, 0.86],    // Aldebaran
  [81.57, 28.61, 1.65],    // Elnath
  [56.87, 24.11, 2.5],     // Alcyone (Pleiades)
  [84.41, 21.14, 3.01],    // ζ Tau
  // — Orion
  [88.79, 7.41, 0.5],      // Betelgeuse
  [78.63, -8.2, 0.13],     // Rigel
  [81.28, 6.35, 1.64],     // Bellatrix
  [85.19, -1.94, 1.74],    // Alnitak
  [84.05, -1.2, 1.69],     // Alnilam
  [83.0, -0.3, 2.25],      // Mintaka
  [86.94, -9.67, 2.07],    // Saiph
  [83.78, 9.93, 3.39],     // Meissa
  // — Canis Major / Canis Minor / Lepus
  [101.29, -16.72, -1.46], // Sirius
  [104.66, -28.97, 1.5],   // Adhara
  [107.1, -26.39, 1.83],   // Wezen
  [95.67, -17.96, 1.98],   // Mirzam
  [111.02, -29.3, 2.45],   // Aludra
  [114.83, 5.22, 0.34],    // Procyon
  [83.18, -17.82, 2.58],   // Arneb
  // — Carina / Vela / Puppis (southern)
  [95.99, -52.7, -0.74],   // Canopus
  [138.3, -69.72, 1.69],   // Miaplacidus
  [125.63, -59.51, 1.86],  // Avior
  [139.27, -59.28, 2.26],  // Aspidiske
  [122.38, -47.34, 1.78],  // γ Vel
  [131.18, -54.71, 1.96],  // δ Vel
  [137.0, -43.43, 2.21],   // Suhail
  [120.9, -40.0, 2.25],    // Naos
  // — Crux / Centaurus / Lupus (southern)
  [186.65, -63.1, 0.77],   // Acrux
  [191.93, -59.69, 1.25],  // Mimosa
  [187.79, -57.11, 1.64],  // Gacrux
  [183.79, -58.75, 2.8],   // δ Cru
  [219.9, -60.83, -0.27],  // α Centauri
  [210.96, -60.37, 0.61],  // Hadar
  [211.67, -36.37, 2.06],  // Menkent
  [190.38, -48.96, 2.17],  // γ Cen
  [204.97, -53.47, 2.3],   // ε Cen
  [220.48, -47.39, 2.3],   // α Lup
  // — Scorpius
  [247.35, -26.43, 1.06],  // Antares
  [263.4, -37.1, 1.63],    // Shaula
  [264.33, -43.0, 1.87],   // Sargas
  [240.08, -22.62, 2.29],  // Dschubba
  [241.36, -19.81, 2.62],  // Acrab
  [252.54, -34.29, 2.29],  // ε Sco
  [265.62, -39.03, 2.39],  // κ Sco
  [245.3, -25.59, 2.88],   // σ Sco
  [248.97, -28.22, 2.82],  // τ Sco
  // — Sagittarius (teapot)
  [276.04, -34.38, 1.85],  // Kaus Australis
  [283.82, -26.3, 2.06],   // Nunki
  [285.65, -29.88, 2.6],   // Ascella
  [275.25, -29.83, 2.7],   // Kaus Media
  [276.99, -25.42, 2.81],  // Kaus Borealis
  // — Ophiuchus / Serpens / Libra
  [263.73, 12.56, 2.08],   // Rasalhague
  [257.59, -15.72, 2.43],  // Sabik
  [249.29, -10.57, 2.57],  // ζ Oph
  [265.87, 4.57, 2.76],    // Cebalrai
  [236.07, 6.43, 2.62],    // Unukalhai
  [229.25, -9.38, 2.61],   // Zubeneschamali
  [222.72, -16.04, 2.75],  // Zubenelgenubi
  // — Pegasus / Andromeda / Perseus / Aries
  [346.19, 15.21, 2.49],   // Markab
  [345.94, 28.08, 2.42],   // Scheat
  [3.31, 15.18, 2.83],     // Algenib
  [326.05, 9.88, 2.38],    // Enif
  [2.1, 29.09, 2.06],      // Alpheratz
  [17.43, 35.62, 2.05],    // Mirach
  [30.97, 42.33, 2.1],     // Almach
  [51.08, 49.86, 1.79],    // Mirfak
  [47.04, 40.96, 2.09],    // Algol
  [31.79, 23.46, 2.0],     // Hamal
  [28.66, 20.81, 2.64],    // Sheratan
  // — Cetus / Eridanus / Pisces Austrinus / Aquarius
  [10.9, -17.99, 2.04],    // Diphda
  [45.57, 4.09, 2.53],     // Menkar
  [24.43, -57.24, 0.46],   // Achernar
  [76.96, -5.09, 2.79],    // Cursa
  [344.41, -29.62, 1.16],  // Fomalhaut
  [322.89, -5.57, 2.9],    // Sadalsuud
  [331.45, -0.32, 2.94],   // Sadalmelik
  // — Grus / Phoenix / Pavo / Triangulum Australe (southern)
  [332.06, -46.96, 1.74],  // Alnair
  [340.67, -46.88, 2.11],  // β Gru
  [6.57, -42.31, 2.38],    // Ankaa
  [306.41, -56.74, 1.94],  // Peacock
  [252.17, -69.03, 1.92],  // Atria
  // — Hydra / Corvus / Columba
  [141.9, -8.66, 1.98],    // Alphard
  [183.95, -17.54, 2.59],  // Gienah Corvi
  [188.6, -23.4, 2.65],    // Kraz
  [84.91, -34.07, 2.65]    // Phact
]

export interface ProjectedStar {
  /** Percent coordinates within the sky layer. */
  x: number
  y: number
  /** Rendered diameter in px and core brightness 0..1 (magnitude-driven). */
  sizePx: number
  brightness: number
  /** Stable catalog index — keys React nodes and twinkle phase. */
  index: number
  major: boolean
}

/** Horizontal span of the panorama in azimuth degrees (60°→300°: an
 * east–south–west sweep, matching the sun and moon arcs). */
const PANORAMA_START_AZ = 60
const PANORAMA_SPAN_AZ = 240
const MIN_ALTITUDE_DEG = 0.5

/**
 * Projects the catalog onto the sky layer for an observer and instant.
 * The panorama faces SOUTH for every observer: east lands on the left
 * (matching the sun/moon rise side) at any latitude, northern users get the
 * seasonal parade along the ecliptic, and southern users get their own
 * icons — Crux and α Centauri circle the south celestial pole in frame.
 */
export function projectBrightStars(
  atMs: number,
  latitudeDeg: number,
  longitudeDeg: number
): ProjectedStar[] {
  const projected: ProjectedStar[] = []
  for (let index = 0; index < BRIGHT_STARS.length; index += 1) {
    const [ra, dec, magnitude] = BRIGHT_STARS[index]
    const { altitudeDeg, azimuthDeg } = equatorialToHorizontal(
      atMs,
      latitudeDeg,
      longitudeDeg,
      ra,
      dec
    )
    if (altitudeDeg < MIN_ALTITUDE_DEG) continue

    if (azimuthDeg < PANORAMA_START_AZ || azimuthDeg > PANORAMA_START_AZ + PANORAMA_SPAN_AZ) {
      continue
    }

    const x = ((azimuthDeg - PANORAMA_START_AZ) / PANORAMA_SPAN_AZ) * 100
    // Compress altitude non-linearly so near-zenith stars (UK summer Vega)
    // stay in frame while the horizon zone keeps natural spacing.
    const y = 88 - 80 * Math.pow(Math.min(altitudeDeg, 90) / 90, 0.72)

    projected.push({
      x,
      y,
      sizePx: Math.min(4.2, Math.max(1.3, 3.8 - 0.55 * magnitude)),
      brightness: Math.min(1, Math.max(0.35, 1.05 - 0.16 * magnitude)),
      index,
      major: magnitude < 1
    })
  }
  return projected
}
