/**
 * GOLDEN — absolute pixel outputs of the transcript height estimator, captured
 * from the UNMODIFIED estimator BEFORE the layout-epoch seam was opened.
 *
 * Provenance. Every number below was produced by running the pristine
 * `src/renderer/src/lib/TranscriptVirtualWindow.ts` (git blob
 * 9ffd42e4e9254cb18c955e08719a9babe31ca061, identical to
 * `HEAD:src/renderer/src/lib/TranscriptVirtualWindow.ts` at commit fbb3c5887)
 * and printing its return values, before the first edit to the estimator.
 *
 * There is no commit pairing this file with the pristine estimator — the work
 * was uncommitted at capture time, so do not go looking for one. Reproduce the
 * claim instead, which is stronger than a commit anyway:
 *
 *   git show HEAD:src/renderer/src/lib/TranscriptVirtualWindow.ts > /tmp/pristine.ts
 *   # swap it in, run THIS file, restore
 *
 * It passes unchanged against that blob. Two independent reviewers ran exactly
 * that and confirmed it.
 *
 * Why the numbers are LITERAL. The estimator's existing suite asserts things
 * like `toBe(Math.round(2000 * CONTENT_PX_PER_CHAR))` — the assertion is
 * re-derived from the very constant under test, so it moves with any retune and
 * proves only the SHAPE of the arithmetic, never its magnitude.
 * `CONTENT_PX_PER_CHAR` can be set to anything in roughly [0.28, 0.70] with that
 * suite still green. Nothing here may import `CONTENT_PX_PER_CHAR`,
 * `ESTIMATED_ROW_HEIGHT_PX`, `CONTENT_SCALE_CAP_PX`,
 * `VIEWPORT_CLAMPED_ESTIMATE_CAP_PX` or `RUN_BOUNDARY_HEIGHT_PX`: a golden that
 * re-derives its expectation from the thing it is pinning is tautological, and
 * would inherit the exact defect it exists to close.
 *
 * Coverage is by BRANCH EDGE, not by round number. For all twelve row types the
 * lengths bracket: the per-type floor crossover (base/rate, either side — for
 * `assistant` that is 524 -> 220 and 525 -> 221), the ceiling crossover (the
 * viewport-clamped 360 or the generic 1400), lengths whose scaled height is ODD
 * so paired-lane `Math.round(scaled / 2)` rounding is captured off the cap
 * (`fanoutResult` at 764 -> 321 -> 161, where 161 * 2 !== 321), `Math.round`
 * half-up ties (1225 -> 514.5 -> 515, 1275 -> 535.5 -> 536), saturation, and the
 * degenerate inputs -1 / 0.5 / NaN / Infinity. Both booleans are crossed, so the
 * run-boundary band is pinned ABSOLUTELY on a halved lane row rather than only
 * as a difference of differences.
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import type { VirtualRowType } from './TranscriptVirtualWindow'
import {
  estimatedHeightFor,
  geometryKey,
  measurementKey,
  projectRow
} from './TranscriptVirtualWindow'

/**
 * `[rowType, contentLength, plain, runBoundary, pairedLane, pairedLaneWithRunBoundary]`
 * — the four cells are `hasRunBoundary` x `pairFanoutLanes`.
 */
type EstimateGolden = readonly [VirtualRowType, number, number, number, number, number]

const ESTIMATE_GOLDENS: readonly EstimateGolden[] = [
  ['user', 0, 88, 132, 88, 132],
  ['user', 1, 88, 132, 88, 132],
  ['user', 209, 88, 132, 88, 132],
  ['user', 210, 88, 132, 88, 132],
  ['user', 211, 89, 133, 89, 133],
  ['user', 212, 89, 133, 89, 133],
  ['user', 668, 281, 325, 281, 325],
  ['user', 764, 321, 365, 321, 365],
  ['user', 856, 360, 404, 360, 404],
  ['user', 857, 360, 404, 360, 404],
  ['user', 858, 360, 404, 360, 404],
  ['user', 1225, 515, 559, 515, 559],
  ['user', 1275, 536, 580, 536, 580],
  ['user', 3332, 1399, 1443, 1399, 1443],
  ['user', 3333, 1400, 1444, 1400, 1444],
  ['user', 3334, 1400, 1444, 1400, 1444],
  ['user', 100000, 1400, 1444, 1400, 1444],
  ['user', -1, 88, 132, 88, 132],
  ['user', 0.5, 88, 132, 88, 132],
  ['user', NaN, NaN, NaN, NaN, NaN],
  ['user', Infinity, 1400, 1444, 1400, 1444],
  ['assistant', 0, 220, 264, 220, 264],
  ['assistant', 1, 220, 264, 220, 264],
  ['assistant', 523, 220, 264, 220, 264],
  ['assistant', 524, 220, 264, 220, 264],
  ['assistant', 525, 221, 265, 221, 265],
  ['assistant', 526, 221, 265, 221, 265],
  ['assistant', 668, 281, 325, 281, 325],
  ['assistant', 764, 321, 365, 321, 365],
  ['assistant', 856, 360, 404, 360, 404],
  ['assistant', 857, 360, 404, 360, 404],
  ['assistant', 858, 360, 404, 360, 404],
  ['assistant', 1225, 515, 559, 515, 559],
  ['assistant', 1275, 536, 580, 536, 580],
  ['assistant', 3332, 1399, 1443, 1399, 1443],
  ['assistant', 3333, 1400, 1444, 1400, 1444],
  ['assistant', 3334, 1400, 1444, 1400, 1444],
  ['assistant', 100000, 1400, 1444, 1400, 1444],
  ['assistant', -1, 220, 264, 220, 264],
  ['assistant', 0.5, 220, 264, 220, 264],
  ['assistant', NaN, NaN, NaN, NaN, NaN],
  ['assistant', Infinity, 1400, 1444, 1400, 1444],
  ['system', 0, 64, 108, 64, 108],
  ['system', 1, 64, 108, 64, 108],
  ['system', 152, 64, 108, 64, 108],
  ['system', 153, 64, 108, 64, 108],
  ['system', 154, 65, 109, 65, 109],
  ['system', 155, 65, 109, 65, 109],
  ['system', 668, 281, 325, 281, 325],
  ['system', 764, 321, 365, 321, 365],
  ['system', 856, 360, 404, 360, 404],
  ['system', 857, 360, 404, 360, 404],
  ['system', 858, 360, 404, 360, 404],
  ['system', 1225, 515, 559, 515, 559],
  ['system', 1275, 536, 580, 536, 580],
  ['system', 3332, 1399, 1443, 1399, 1443],
  ['system', 3333, 1400, 1444, 1400, 1444],
  ['system', 3334, 1400, 1444, 1400, 1444],
  ['system', 100000, 1400, 1444, 1400, 1444],
  ['system', -1, 64, 108, 64, 108],
  ['system', 0.5, 64, 108, 64, 108],
  ['system', NaN, NaN, NaN, NaN, NaN],
  ['system', Infinity, 1400, 1444, 1400, 1444],
  ['error', 0, 80, 124, 80, 124],
  ['error', 1, 80, 124, 80, 124],
  ['error', 190, 80, 124, 80, 124],
  ['error', 191, 80, 124, 80, 124],
  ['error', 192, 81, 125, 81, 125],
  ['error', 193, 81, 125, 81, 125],
  ['error', 668, 281, 325, 281, 325],
  ['error', 764, 321, 365, 321, 365],
  ['error', 856, 360, 404, 360, 404],
  ['error', 857, 360, 404, 360, 404],
  ['error', 858, 360, 404, 360, 404],
  ['error', 1225, 515, 559, 515, 559],
  ['error', 1275, 536, 580, 536, 580],
  ['error', 3332, 1399, 1443, 1399, 1443],
  ['error', 3333, 1400, 1444, 1400, 1444],
  ['error', 3334, 1400, 1444, 1400, 1444],
  ['error', 100000, 1400, 1444, 1400, 1444],
  ['error', -1, 80, 124, 80, 124],
  ['error', 0.5, 80, 124, 80, 124],
  ['error', NaN, NaN, NaN, NaN, NaN],
  ['error', Infinity, 1400, 1444, 1400, 1444],
  ['tool', 0, 180, 224, 180, 224],
  ['tool', 1, 180, 224, 180, 224],
  ['tool', 428, 180, 224, 180, 224],
  ['tool', 429, 180, 224, 180, 224],
  ['tool', 430, 181, 225, 181, 225],
  ['tool', 431, 181, 225, 181, 225],
  ['tool', 668, 281, 325, 281, 325],
  ['tool', 764, 321, 365, 321, 365],
  ['tool', 856, 360, 404, 360, 404],
  ['tool', 857, 360, 404, 360, 404],
  ['tool', 858, 360, 404, 360, 404],
  ['tool', 1225, 515, 559, 515, 559],
  ['tool', 1275, 536, 580, 536, 580],
  ['tool', 3332, 1399, 1443, 1399, 1443],
  ['tool', 3333, 1400, 1444, 1400, 1444],
  ['tool', 3334, 1400, 1444, 1400, 1444],
  ['tool', 100000, 1400, 1444, 1400, 1444],
  ['tool', -1, 180, 224, 180, 224],
  ['tool', 0.5, 180, 224, 180, 224],
  ['tool', NaN, NaN, NaN, NaN, NaN],
  ['tool', Infinity, 1400, 1444, 1400, 1444],
  ['participantHealth', 0, 132, 176, 132, 176],
  ['participantHealth', 1, 132, 176, 132, 176],
  ['participantHealth', 668, 132, 176, 132, 176],
  ['participantHealth', 764, 132, 176, 132, 176],
  ['participantHealth', 856, 132, 176, 132, 176],
  ['participantHealth', 857, 132, 176, 132, 176],
  ['participantHealth', 858, 132, 176, 132, 176],
  ['participantHealth', 1225, 132, 176, 132, 176],
  ['participantHealth', 1275, 132, 176, 132, 176],
  ['participantHealth', 3332, 132, 176, 132, 176],
  ['participantHealth', 3333, 132, 176, 132, 176],
  ['participantHealth', 3334, 132, 176, 132, 176],
  ['participantHealth', 100000, 132, 176, 132, 176],
  ['participantHealth', -1, 132, 176, 132, 176],
  ['participantHealth', 0.5, 132, 176, 132, 176],
  ['participantHealth', NaN, 132, 176, 132, 176],
  ['participantHealth', Infinity, 132, 176, 132, 176],
  ['delegation', 0, 104, 148, 104, 148],
  ['delegation', 1, 104, 148, 104, 148],
  ['delegation', 668, 104, 148, 104, 148],
  ['delegation', 764, 104, 148, 104, 148],
  ['delegation', 856, 104, 148, 104, 148],
  ['delegation', 857, 104, 148, 104, 148],
  ['delegation', 858, 104, 148, 104, 148],
  ['delegation', 1225, 104, 148, 104, 148],
  ['delegation', 1275, 104, 148, 104, 148],
  ['delegation', 3332, 104, 148, 104, 148],
  ['delegation', 3333, 104, 148, 104, 148],
  ['delegation', 3334, 104, 148, 104, 148],
  ['delegation', 100000, 104, 148, 104, 148],
  ['delegation', -1, 104, 148, 104, 148],
  ['delegation', 0.5, 104, 148, 104, 148],
  ['delegation', NaN, 104, 148, 104, 148],
  ['delegation', Infinity, 104, 148, 104, 148],
  ['return', 0, 280, 324, 140, 184],
  ['return', 1, 280, 324, 140, 184],
  ['return', 666, 280, 324, 140, 184],
  ['return', 667, 280, 324, 140, 184],
  ['return', 668, 281, 325, 141, 185],
  ['return', 669, 281, 325, 141, 185],
  ['return', 764, 321, 365, 161, 205],
  ['return', 856, 360, 404, 180, 224],
  ['return', 857, 360, 404, 180, 224],
  ['return', 858, 360, 404, 180, 224],
  ['return', 1225, 360, 404, 180, 224],
  ['return', 1275, 360, 404, 180, 224],
  ['return', 3332, 360, 404, 180, 224],
  ['return', 3333, 360, 404, 180, 224],
  ['return', 3334, 360, 404, 180, 224],
  ['return', 100000, 360, 404, 180, 224],
  ['return', -1, 280, 324, 140, 184],
  ['return', 0.5, 280, 324, 140, 184],
  ['return', NaN, NaN, NaN, NaN, NaN],
  ['return', Infinity, 360, 404, 180, 224],
  ['threadMessage', 0, 300, 344, 300, 344],
  ['threadMessage', 1, 300, 344, 300, 344],
  ['threadMessage', 668, 300, 344, 300, 344],
  ['threadMessage', 714, 300, 344, 300, 344],
  ['threadMessage', 715, 300, 344, 300, 344],
  ['threadMessage', 716, 301, 345, 301, 345],
  ['threadMessage', 717, 301, 345, 301, 345],
  ['threadMessage', 764, 321, 365, 321, 365],
  ['threadMessage', 856, 360, 404, 360, 404],
  ['threadMessage', 857, 360, 404, 360, 404],
  ['threadMessage', 858, 360, 404, 360, 404],
  ['threadMessage', 1225, 360, 404, 360, 404],
  ['threadMessage', 1275, 360, 404, 360, 404],
  ['threadMessage', 3332, 360, 404, 360, 404],
  ['threadMessage', 3333, 360, 404, 360, 404],
  ['threadMessage', 3334, 360, 404, 360, 404],
  ['threadMessage', 100000, 360, 404, 360, 404],
  ['threadMessage', -1, 300, 344, 300, 344],
  ['threadMessage', 0.5, 300, 344, 300, 344],
  ['threadMessage', NaN, NaN, NaN, NaN, NaN],
  ['threadMessage', Infinity, 360, 404, 360, 404],
  ['fanoutResult', 0, 320, 364, 160, 204],
  ['fanoutResult', 1, 320, 364, 160, 204],
  ['fanoutResult', 668, 320, 364, 160, 204],
  ['fanoutResult', 762, 320, 364, 160, 204],
  ['fanoutResult', 763, 320, 364, 160, 204],
  ['fanoutResult', 764, 321, 365, 161, 205],
  ['fanoutResult', 765, 321, 365, 161, 205],
  ['fanoutResult', 856, 360, 404, 180, 224],
  ['fanoutResult', 857, 360, 404, 180, 224],
  ['fanoutResult', 858, 360, 404, 180, 224],
  ['fanoutResult', 1225, 360, 404, 180, 224],
  ['fanoutResult', 1275, 360, 404, 180, 224],
  ['fanoutResult', 3332, 360, 404, 180, 224],
  ['fanoutResult', 3333, 360, 404, 180, 224],
  ['fanoutResult', 3334, 360, 404, 180, 224],
  ['fanoutResult', 100000, 360, 404, 180, 224],
  ['fanoutResult', -1, 320, 364, 160, 204],
  ['fanoutResult', 0.5, 320, 364, 160, 204],
  ['fanoutResult', NaN, NaN, NaN, NaN, NaN],
  ['fanoutResult', Infinity, 360, 404, 180, 224],
  ['guestReply', 0, 220, 264, 220, 264],
  ['guestReply', 1, 220, 264, 220, 264],
  ['guestReply', 523, 220, 264, 220, 264],
  ['guestReply', 524, 220, 264, 220, 264],
  ['guestReply', 525, 221, 265, 221, 265],
  ['guestReply', 526, 221, 265, 221, 265],
  ['guestReply', 668, 281, 325, 281, 325],
  ['guestReply', 764, 321, 365, 321, 365],
  ['guestReply', 856, 360, 404, 360, 404],
  ['guestReply', 857, 360, 404, 360, 404],
  ['guestReply', 858, 360, 404, 360, 404],
  ['guestReply', 1225, 515, 559, 515, 559],
  ['guestReply', 1275, 536, 580, 536, 580],
  ['guestReply', 3332, 1399, 1443, 1399, 1443],
  ['guestReply', 3333, 1400, 1444, 1400, 1444],
  ['guestReply', 3334, 1400, 1444, 1400, 1444],
  ['guestReply', 100000, 1400, 1444, 1400, 1444],
  ['guestReply', -1, 220, 264, 220, 264],
  ['guestReply', 0.5, 220, 264, 220, 264],
  ['guestReply', NaN, NaN, NaN, NaN, NaN],
  ['guestReply', Infinity, 1400, 1444, 1400, 1444],
  ['collaborator', 0, 132, 176, 132, 176],
  ['collaborator', 1, 132, 176, 132, 176],
  ['collaborator', 314, 132, 176, 132, 176],
  ['collaborator', 315, 132, 176, 132, 176],
  ['collaborator', 316, 133, 177, 133, 177],
  ['collaborator', 317, 133, 177, 133, 177],
  ['collaborator', 668, 281, 325, 281, 325],
  ['collaborator', 764, 321, 365, 321, 365],
  ['collaborator', 856, 360, 404, 360, 404],
  ['collaborator', 857, 360, 404, 360, 404],
  ['collaborator', 858, 360, 404, 360, 404],
  ['collaborator', 1225, 515, 559, 515, 559],
  ['collaborator', 1275, 536, 580, 536, 580],
  ['collaborator', 3332, 1399, 1443, 1399, 1443],
  ['collaborator', 3333, 1400, 1444, 1400, 1444],
  ['collaborator', 3334, 1400, 1444, 1400, 1444],
  ['collaborator', 100000, 1400, 1444, 1400, 1444],
  ['collaborator', -1, 132, 176, 132, 176],
  ['collaborator', 0.5, 132, 176, 132, 176],
  ['collaborator', NaN, NaN, NaN, NaN, NaN],
  ['collaborator', Infinity, 1400, 1444, 1400, 1444]
]

/**
 * `[role, contentLength, activityCount, perActivityOutputLength, activityField,
 * rowType, boundedActivityBodies, unboundedActivityBodies]` — pins the
 * contentLength `projectRow` DERIVES (activity count x 180 chars plus each
 * body, capped per activity at 480 unless bodies render unbounded) as an
 * absolute estimated height, including the `resultSummary` / `outputPreview`
 * precedence and the `Math.max(content.length, activityEstimate)` that only
 * non-`tool` rows take.
 */
type ProjectGolden = readonly [
  'tool' | 'assistant',
  number,
  number,
  number,
  'resultSummary' | 'outputPreview' | 'both',
  VirtualRowType,
  number,
  number
]

const PROJECT_GOLDENS: readonly ProjectGolden[] = [
  ['tool', 0, 0, 0, 'resultSummary', 'system', 64, 64],
  ['tool', 0, 1, 0, 'resultSummary', 'tool', 180, 180],
  ['tool', 0, 1, 0, 'outputPreview', 'tool', 180, 180],
  ['tool', 0, 1, 0, 'both', 'tool', 180, 180],
  ['tool', 0, 1, 479, 'resultSummary', 'tool', 277, 277],
  ['tool', 0, 1, 479, 'outputPreview', 'tool', 277, 277],
  ['tool', 0, 1, 479, 'both', 'tool', 277, 277],
  ['tool', 0, 1, 480, 'resultSummary', 'tool', 277, 277],
  ['tool', 0, 1, 480, 'outputPreview', 'tool', 277, 277],
  ['tool', 0, 1, 480, 'both', 'tool', 277, 277],
  ['tool', 0, 1, 481, 'resultSummary', 'tool', 277, 278],
  ['tool', 0, 1, 481, 'outputPreview', 'tool', 277, 278],
  ['tool', 0, 1, 481, 'both', 'tool', 277, 278],
  ['tool', 0, 1, 100000, 'resultSummary', 'tool', 277, 1400],
  ['tool', 0, 1, 100000, 'outputPreview', 'tool', 277, 1400],
  ['tool', 0, 1, 100000, 'both', 'tool', 277, 1400],
  ['tool', 0, 2, 0, 'resultSummary', 'tool', 180, 180],
  ['tool', 0, 2, 0, 'outputPreview', 'tool', 180, 180],
  ['tool', 0, 2, 0, 'both', 'tool', 180, 180],
  ['tool', 0, 2, 479, 'resultSummary', 'tool', 554, 554],
  ['tool', 0, 2, 479, 'outputPreview', 'tool', 554, 554],
  ['tool', 0, 2, 479, 'both', 'tool', 554, 554],
  ['tool', 0, 2, 480, 'resultSummary', 'tool', 554, 554],
  ['tool', 0, 2, 480, 'outputPreview', 'tool', 554, 554],
  ['tool', 0, 2, 480, 'both', 'tool', 554, 554],
  ['tool', 0, 2, 481, 'resultSummary', 'tool', 554, 555],
  ['tool', 0, 2, 481, 'outputPreview', 'tool', 554, 555],
  ['tool', 0, 2, 481, 'both', 'tool', 554, 555],
  ['tool', 0, 2, 100000, 'resultSummary', 'tool', 554, 1400],
  ['tool', 0, 2, 100000, 'outputPreview', 'tool', 554, 1400],
  ['tool', 0, 2, 100000, 'both', 'tool', 554, 1400],
  ['tool', 0, 10, 0, 'resultSummary', 'tool', 756, 756],
  ['tool', 0, 10, 0, 'outputPreview', 'tool', 756, 756],
  ['tool', 0, 10, 0, 'both', 'tool', 756, 756],
  ['tool', 0, 10, 479, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 0, 10, 479, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 0, 10, 479, 'both', 'tool', 1400, 1400],
  ['tool', 0, 10, 480, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 0, 10, 480, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 0, 10, 480, 'both', 'tool', 1400, 1400],
  ['tool', 0, 10, 481, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 0, 10, 481, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 0, 10, 481, 'both', 'tool', 1400, 1400],
  ['tool', 0, 10, 100000, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 0, 10, 100000, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 0, 10, 100000, 'both', 'tool', 1400, 1400],
  ['tool', 5000, 0, 0, 'resultSummary', 'system', 1400, 1400],
  ['tool', 5000, 1, 0, 'resultSummary', 'tool', 180, 180],
  ['tool', 5000, 1, 0, 'outputPreview', 'tool', 180, 180],
  ['tool', 5000, 1, 0, 'both', 'tool', 180, 180],
  ['tool', 5000, 1, 479, 'resultSummary', 'tool', 277, 277],
  ['tool', 5000, 1, 479, 'outputPreview', 'tool', 277, 277],
  ['tool', 5000, 1, 479, 'both', 'tool', 277, 277],
  ['tool', 5000, 1, 480, 'resultSummary', 'tool', 277, 277],
  ['tool', 5000, 1, 480, 'outputPreview', 'tool', 277, 277],
  ['tool', 5000, 1, 480, 'both', 'tool', 277, 277],
  ['tool', 5000, 1, 481, 'resultSummary', 'tool', 277, 278],
  ['tool', 5000, 1, 481, 'outputPreview', 'tool', 277, 278],
  ['tool', 5000, 1, 481, 'both', 'tool', 277, 278],
  ['tool', 5000, 1, 100000, 'resultSummary', 'tool', 277, 1400],
  ['tool', 5000, 1, 100000, 'outputPreview', 'tool', 277, 1400],
  ['tool', 5000, 1, 100000, 'both', 'tool', 277, 1400],
  ['tool', 5000, 2, 0, 'resultSummary', 'tool', 180, 180],
  ['tool', 5000, 2, 0, 'outputPreview', 'tool', 180, 180],
  ['tool', 5000, 2, 0, 'both', 'tool', 180, 180],
  ['tool', 5000, 2, 479, 'resultSummary', 'tool', 554, 554],
  ['tool', 5000, 2, 479, 'outputPreview', 'tool', 554, 554],
  ['tool', 5000, 2, 479, 'both', 'tool', 554, 554],
  ['tool', 5000, 2, 480, 'resultSummary', 'tool', 554, 554],
  ['tool', 5000, 2, 480, 'outputPreview', 'tool', 554, 554],
  ['tool', 5000, 2, 480, 'both', 'tool', 554, 554],
  ['tool', 5000, 2, 481, 'resultSummary', 'tool', 554, 555],
  ['tool', 5000, 2, 481, 'outputPreview', 'tool', 554, 555],
  ['tool', 5000, 2, 481, 'both', 'tool', 554, 555],
  ['tool', 5000, 2, 100000, 'resultSummary', 'tool', 554, 1400],
  ['tool', 5000, 2, 100000, 'outputPreview', 'tool', 554, 1400],
  ['tool', 5000, 2, 100000, 'both', 'tool', 554, 1400],
  ['tool', 5000, 10, 0, 'resultSummary', 'tool', 756, 756],
  ['tool', 5000, 10, 0, 'outputPreview', 'tool', 756, 756],
  ['tool', 5000, 10, 0, 'both', 'tool', 756, 756],
  ['tool', 5000, 10, 479, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 5000, 10, 479, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 5000, 10, 479, 'both', 'tool', 1400, 1400],
  ['tool', 5000, 10, 480, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 5000, 10, 480, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 5000, 10, 480, 'both', 'tool', 1400, 1400],
  ['tool', 5000, 10, 481, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 5000, 10, 481, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 5000, 10, 481, 'both', 'tool', 1400, 1400],
  ['tool', 5000, 10, 100000, 'resultSummary', 'tool', 1400, 1400],
  ['tool', 5000, 10, 100000, 'outputPreview', 'tool', 1400, 1400],
  ['tool', 5000, 10, 100000, 'both', 'tool', 1400, 1400],
  ['assistant', 0, 0, 0, 'resultSummary', 'assistant', 220, 220],
  ['assistant', 0, 1, 0, 'resultSummary', 'assistant', 220, 220],
  ['assistant', 0, 1, 0, 'outputPreview', 'assistant', 220, 220],
  ['assistant', 0, 1, 0, 'both', 'assistant', 220, 220],
  ['assistant', 0, 1, 479, 'resultSummary', 'assistant', 277, 277],
  ['assistant', 0, 1, 479, 'outputPreview', 'assistant', 277, 277],
  ['assistant', 0, 1, 479, 'both', 'assistant', 277, 277],
  ['assistant', 0, 1, 480, 'resultSummary', 'assistant', 277, 277],
  ['assistant', 0, 1, 480, 'outputPreview', 'assistant', 277, 277],
  ['assistant', 0, 1, 480, 'both', 'assistant', 277, 277],
  ['assistant', 0, 1, 481, 'resultSummary', 'assistant', 277, 278],
  ['assistant', 0, 1, 481, 'outputPreview', 'assistant', 277, 278],
  ['assistant', 0, 1, 481, 'both', 'assistant', 277, 278],
  ['assistant', 0, 1, 100000, 'resultSummary', 'assistant', 277, 1400],
  ['assistant', 0, 1, 100000, 'outputPreview', 'assistant', 277, 1400],
  ['assistant', 0, 1, 100000, 'both', 'assistant', 277, 1400],
  ['assistant', 0, 2, 0, 'resultSummary', 'assistant', 220, 220],
  ['assistant', 0, 2, 0, 'outputPreview', 'assistant', 220, 220],
  ['assistant', 0, 2, 0, 'both', 'assistant', 220, 220],
  ['assistant', 0, 2, 479, 'resultSummary', 'assistant', 554, 554],
  ['assistant', 0, 2, 479, 'outputPreview', 'assistant', 554, 554],
  ['assistant', 0, 2, 479, 'both', 'assistant', 554, 554],
  ['assistant', 0, 2, 480, 'resultSummary', 'assistant', 554, 554],
  ['assistant', 0, 2, 480, 'outputPreview', 'assistant', 554, 554],
  ['assistant', 0, 2, 480, 'both', 'assistant', 554, 554],
  ['assistant', 0, 2, 481, 'resultSummary', 'assistant', 554, 555],
  ['assistant', 0, 2, 481, 'outputPreview', 'assistant', 554, 555],
  ['assistant', 0, 2, 481, 'both', 'assistant', 554, 555],
  ['assistant', 0, 2, 100000, 'resultSummary', 'assistant', 554, 1400],
  ['assistant', 0, 2, 100000, 'outputPreview', 'assistant', 554, 1400],
  ['assistant', 0, 2, 100000, 'both', 'assistant', 554, 1400],
  ['assistant', 0, 10, 0, 'resultSummary', 'assistant', 756, 756],
  ['assistant', 0, 10, 0, 'outputPreview', 'assistant', 756, 756],
  ['assistant', 0, 10, 0, 'both', 'assistant', 756, 756],
  ['assistant', 0, 10, 479, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 479, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 479, 'both', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 480, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 480, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 480, 'both', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 481, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 481, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 481, 'both', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 100000, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 100000, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 0, 10, 100000, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 0, 0, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 0, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 0, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 0, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 479, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 479, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 479, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 480, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 480, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 480, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 481, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 481, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 481, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 100000, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 100000, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 1, 100000, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 0, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 0, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 0, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 479, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 479, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 479, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 480, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 480, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 480, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 481, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 481, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 481, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 100000, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 100000, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 2, 100000, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 0, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 0, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 0, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 479, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 479, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 479, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 480, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 480, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 480, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 481, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 481, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 481, 'both', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 100000, 'resultSummary', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 100000, 'outputPreview', 'assistant', 1400, 1400],
  ['assistant', 5000, 10, 100000, 'both', 'assistant', 1400, 1400]
]

/** `[rowKey, contentVersion, bucket, expanded, measurementKey, geometryKey]`. */
type KeyGolden = readonly [string, string, number, boolean, string, string]

const KEY_GOLDENS: readonly KeyGolden[] = [
  ['msg#0', 'a:12:0:0:0:abc', 0, false, 'msg#0|a:12:0:0:0:abc|0|0', 'msg#0|0|0'],
  ['msg#0', 'a:12:0:0:0:abc', 0, true, 'msg#0|a:12:0:0:0:abc|0|1', 'msg#0|0|1'],
  [
    'msg#1',
    't:2:success|success|:40',
    10,
    false,
    'msg#1|t:2:success|success|:40|10|0',
    'msg#1|10|0'
  ],
  ['dup#2', 'u:5:0:0:0:zz', 12, true, 'dup#2|u:5:0:0:0:zz|12|1', 'dup#2|12|1']
]

function activityAt(
  index: number,
  field: 'resultSummary' | 'outputPreview' | 'both',
  body: string
): ToolActivity {
  const activity = { id: `a${index}`, status: 'success' } as ToolActivity
  if (field === 'resultSummary' || field === 'both') activity.resultSummary = body
  if (field === 'outputPreview' || field === 'both') activity.outputPreview = body
  return activity
}

describe('transcript estimate goldens (captured from the pre-seam estimator)', () => {
  it('reproduces every captured estimatedHeightFor cell exactly', () => {
    const mismatches: string[] = []
    let compared = 0
    for (const [
      rowType,
      contentLength,
      plain,
      boundary,
      paired,
      pairedBoundary
    ] of ESTIMATE_GOLDENS) {
      const actual = [
        estimatedHeightFor(rowType, false, contentLength),
        estimatedHeightFor(rowType, true, contentLength),
        estimatedHeightFor(rowType, false, contentLength, true),
        estimatedHeightFor(rowType, true, contentLength, true)
      ]
      const expected = [plain, boundary, paired, pairedBoundary]
      for (let cell = 0; cell < expected.length; cell += 1) {
        compared += 1
        // Object.is, not ===, so the NaN goldens are a real comparison.
        if (!Object.is(actual[cell], expected[cell])) {
          mismatches.push(
            `${rowType}@${contentLength}[${cell}] ${actual[cell]} != ${expected[cell]}`
          )
        }
      }
    }
    // Non-vacuity: an empty `mismatches` only means something if the loop ran
    // over the whole captured table.
    expect(ESTIMATE_GOLDENS.length).toBe(242)
    expect(compared).toBe(ESTIMATE_GOLDENS.length * 4)
    expect(mismatches).toEqual([])
  })

  it('pins the load-bearing estimate edges as absolute numbers', () => {
    // Spot checks, written out so a reader can see the magnitudes the table
    // holds without decoding it. Every value here is a literal, never derived.
    expect(estimatedHeightFor('assistant', false, 524)).toBe(220)
    expect(estimatedHeightFor('assistant', false, 525)).toBe(221)
    expect(estimatedHeightFor('assistant', false, 3332)).toBe(1399)
    expect(estimatedHeightFor('assistant', false, 3333)).toBe(1400)
    expect(estimatedHeightFor('assistant', false, 100000)).toBe(1400)
    expect(estimatedHeightFor('assistant', true, 2000)).toBe(884)
    // Paired-lane halving is NOT exact at every length: 764 chars scales to 321,
    // and Math.round(321 / 2) is 161, so two halves are 322. The existing suite
    // samples only the even saturation point and so asserts an invariant the
    // code does not satisfy.
    expect(estimatedHeightFor('fanoutResult', false, 764)).toBe(321)
    expect(estimatedHeightFor('fanoutResult', false, 764, true)).toBe(161)
    expect(estimatedHeightFor('fanoutResult', false, 100000)).toBe(360)
    expect(estimatedHeightFor('fanoutResult', false, 100000, true)).toBe(180)
    // The run-boundary band on a HALVED lane row, absolutely.
    expect(estimatedHeightFor('fanoutResult', true, 100000, true)).toBe(224)
    // The two types with no content scaling at all.
    expect(estimatedHeightFor('delegation', false, 100000)).toBe(104)
    expect(estimatedHeightFor('participantHealth', false, 100000)).toBe(132)
    // Degenerate input propagates rather than clamping.
    expect(estimatedHeightFor('assistant', false, NaN)).toBe(NaN)
    expect(estimatedHeightFor('assistant', false, Infinity)).toBe(1400)
  })

  it('reproduces every captured projectRow estimate exactly', () => {
    const mismatches: string[] = []
    let compared = 0
    for (const [
      role,
      contentLength,
      activityCount,
      outputLength,
      field,
      rowType,
      bounded,
      unbounded
    ] of PROJECT_GOLDENS) {
      const body = 'x'.repeat(outputLength)
      const toolActivities: ToolActivity[] = []
      for (let index = 0; index < activityCount; index += 1) {
        toolActivities.push(activityAt(index, field, body))
      }
      const message = {
        id: 'msg',
        role,
        content: 'y'.repeat(contentLength),
        toolActivities
      } as ChatMessage
      const cells = [false, true].map((unboundedActivityBodies) => {
        const row = projectRow(message, 0, null, unboundedActivityBodies, false, 0)
        return row ? row.estimatedHeight : -1
      })
      const classified = projectRow(message, 0, null, false, false, 0)?.rowType
      const expected = [bounded, unbounded]
      compared += 1
      if (classified !== rowType) {
        mismatches.push(
          `${role}/${activityCount}/${outputLength}/${field} type ${classified} != ${rowType}`
        )
      }
      for (let cell = 0; cell < expected.length; cell += 1) {
        compared += 1
        if (!Object.is(cells[cell], expected[cell])) {
          mismatches.push(
            `${role}/c${contentLength}/${activityCount}/${outputLength}/${field}[${cell}] ${cells[cell]} != ${expected[cell]}`
          )
        }
      }
    }
    expect(PROJECT_GOLDENS.length).toBe(184)
    expect(compared).toBe(PROJECT_GOLDENS.length * 3)
    expect(mismatches).toEqual([])
  })

  it('reproduces the measurement and geometry cache key strings exactly', () => {
    const mismatches: string[] = []
    let compared = 0
    for (const [rowKey, rowContentVersion, bucket, expanded, measured, geometry] of KEY_GOLDENS) {
      compared += 2
      if (measurementKey(rowKey, rowContentVersion, bucket, expanded) !== measured) {
        mismatches.push(`measurementKey ${rowKey} != ${measured}`)
      }
      if (geometryKey(rowKey, bucket, expanded) !== geometry) {
        mismatches.push(`geometryKey ${rowKey} != ${geometry}`)
      }
    }
    expect(KEY_GOLDENS.length).toBe(4)
    expect(compared).toBe(KEY_GOLDENS.length * 2)
    expect(mismatches).toEqual([])
    // Absolute, so the key FORMAT is pinned and not only its self-consistency.
    expect(measurementKey('msg#0', 'a:12:0:0:0:abc', 0, false)).toBe('msg#0|a:12:0:0:0:abc|0|0')
    expect(geometryKey('dup#2', 12, true)).toBe('dup#2|12|1')
  })
})
