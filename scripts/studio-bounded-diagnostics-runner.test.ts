import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  DIAGNOSTICS_PRESENTED_RATE_BOUNDS,
  DIAGNOSTICS_VISIBLE_RSS_CEILING_MEGABYTES,
  UNPROMOTED_SESSION_DEPENDENCIES,
  assertDiagnostics,
  buildFramePtsCensusCommand,
  buildReferenceExtractCommand,
  describeFixtureContract,
  isPlayableSample,
  mediaToolCandidates,
  parseFramePtsCensus,
  parseOcrInteger,
  parseVisibleHud,
  REQUIRED_RESOURCE_FIELDS,
  REQUIRED_VISIBLE_COUNTERS,
  resolveMediaTool,
  runBoundedDiagnostics
} = require('./studio-bounded-diagnostics-runner.cjs')

/**
 * Builds one truthful HUD observation. Tests mutate a single field so a failure
 * names one property rather than "some sample was wrong".
 */
function observation(overrides: Record<string, unknown> = {}) {
  const diagnostics = {
    droppedFrames: 0,
    heldFrames: 2,
    shownFrames: 300,
    cacheHits: 120,
    textures: 8,
    ...((overrides.diagnostics as Record<string, number>) || {})
  }
  const players = {
    count: 1,
    rssMegabytes: 512,
    ...((overrides.players as Record<string, number>) || {})
  }
  return {
    observed: {
      contentPtsText: '00:00:10.000',
      contentPtsSeconds: 10,
      state: 'PLAY',
      assetMatch: { matched: true },
      rawOcrSha256: 'a'.repeat(64),
      ...overrides,
      diagnostics,
      players
    }
  }
}

/** A resource sample shaped like the `ps`/footprint probe the runner consumes. */
function resources(rssKilobytes: number) {
  return {
    ps: { rssKilobytes },
    physicalFootprintBytes: 100,
    peakPhysicalFootprintBytes: 100,
    mallocAllocatedBytes: 100,
    iosurfaceVirtualBytes: 100,
    iosurfaceResidentBytes: 100,
    iosurfaceRegionCount: 1,
    productSurfaceIds: [1],
    mappedRegionIdentities: ['r']
  }
}

/** A truthful two-sample series: 10s -> 20s, 300 -> 600 shown frames = 30fps. */
function truthfulSeries() {
  return [
    observation(),
    observation({
      contentPtsText: '00:00:20.000',
      contentPtsSeconds: 20,
      diagnostics: {
        droppedFrames: 0,
        heldFrames: 3,
        shownFrames: 600,
        cacheHits: 240,
        textures: 8
      }
    })
  ]
}

describe('the promoted runner is actually portable, which is the defect being repaired', () => {
  // THE WHOLE POINT OF THE PROMOTION. The former Outcome 9 runner lived only at
  // .local-only/.../bounded-diagnostics-run.cjs and pulled its session layer from
  // two more untracked siblings. A copy that still reaches into .local-only would
  // be tracked and STILL unrunnable on a fresh clone - the defect intact, now
  // wearing a tracked filename. This control fails if that regresses.
  it('requires nothing from the untracked .local-only evidence root', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'studio-bounded-diagnostics-runner.cjs'),
      'utf8'
    )
    const requires = [...source.matchAll(/require\((['"])(.+?)\1\)/g)].map((m) => m[2])
    expect(requires.length).toBeGreaterThan(0) // not vacuous: the scan found requires
    for (const specifier of requires) {
      expect(specifier).not.toContain('.local-only')
      expect(specifier).not.toContain('lut-run')
      expect(specifier).not.toContain('endurance-run')
    }
  })

  it('hardcodes no operator home directory', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'studio-bounded-diagnostics-runner.cjs'),
      'utf8'
    )
    // The shared session layer this runner was promoted away from pinned
    // `const repoRoot = '/Users/chrisizatt/Documents/AGBench'`, so even a tracked
    // copy would only run on one machine.
    expect(source).not.toContain('/Users/chrisizatt')
  })

  it('resolves media tools across prefixes rather than pinning one installation', () => {
    // NOT a source scan for '/opt/homebrew': listing it is CORRECT. The original
    // defect was pinning it as the ONLY path, which fails on Intel Homebrew
    // (/usr/local) and anywhere ffmpeg is on PATH but not under either prefix.
    const candidates = mediaToolCandidates('ffprobe')
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    const prefixes = new Set(candidates.map((c: string) => c.split('/').slice(0, 3).join('/')))
    expect(prefixes.size).toBeGreaterThanOrEqual(2)
    expect(candidates.every((c: string) => c.endsWith('ffprobe'))).toBe(true)
  })
})

describe('the fixture census is derived, never a pin to a retained blob', () => {
  // MEASURED DEFECT: the untracked runner threw unless the probe returned exactly
  // 22_800 frames. The tracked generator produces 600s at 30fps = 18_000. That pin
  // was bound to a 116MB blob no code synthesises, so inheriting it would make the
  // promoted runner reject its own derivable fixture.
  it('derives the expected frame count from duration and frame rate', () => {
    const contract = describeFixtureContract()
    expect(contract.expectedFrameCount).toBe(contract.durationSeconds * contract.frameRate)
  })

  it('does not inherit the retained-blob census pin of 22800', () => {
    expect(describeFixtureContract().expectedFrameCount).not.toBe(22_800)
  })

  it('tracks the generator rather than restating its numbers', () => {
    const generator = require('./studio-generate-speech-fixture.cjs')
    const contract = describeFixtureContract()
    expect(contract.durationSeconds).toBe(generator.DEFAULT_FIXTURE_DURATION_SECONDS)
    expect(contract.frameRate).toBe(generator.FIXTURE_FRAME_RATE)
  })
})

describe('the PTS census parser survives real ffprobe output', () => {
  // REGRESSION CLASS ALREADY PAID FOR ONCE (0fa2eee40): Homebrew ffprobe emits a
  // trailing comma on 2s boundaries with -of csv=p=0, plus a final empty line. The
  // untracked runner did `.map(Number).filter(Number.isFinite)`, and Number('4,')
  // is NaN - so every boundary frame was silently DISCARDED and the census count
  // was short. A count pin measured against that bug encodes the bug.
  it('recovers frames from rows carrying a trailing comma', () => {
    const parsed = parseFramePtsCensus('0.000000\n2.000000,\n4.000000,\n6.000000\n\n')
    expect(parsed.values).toEqual([0, 2, 4, 6])
    expect(parsed.count).toBe(4)
  })

  it('ignores trailing blank lines without counting them as frames', () => {
    expect(parseFramePtsCensus('0.000000\n1.000000\n\n\n').count).toBe(2)
  })

  it('refuses a row that is not a timestamp instead of dropping it silently', () => {
    // Silent filtering is how the trailing-comma bug hid. Anything unparseable
    // must fail loudly rather than shrink the census.
    expect(() => parseFramePtsCensus('0.000000\nN/A\n2.000000\n')).toThrow(/census/i)
  })
})

describe('media tools resolve portably and fail closed', () => {
  it('rejects a candidate list containing no existing tool, naming the tool', () => {
    expect(() =>
      resolveMediaTool('ffprobe', { candidates: ['/nonexistent/a', '/nonexistent/b'] })
    ).toThrow(/ffprobe/)
  })

  it('returns the first candidate that exists', () => {
    const resolved = resolveMediaTool('sh', {
      candidates: ['/nonexistent/sh', '/bin/sh']
    })
    expect(resolved).toBe('/bin/sh')
  })
})

describe('reference frames are extracted at an exact source PTS', () => {
  const argv = () =>
    buildReferenceExtractCommand({
      assetPath: '/tmp/a.mp4',
      exactSourcePtsSeconds: 12.345678,
      referencePath: '/tmp/ref.png'
    })

  it('selects a single frame with passthrough timing', () => {
    // Without -fps_mode passthrough ffmpeg resamples and the "reference" frame is
    // not the frame the HUD was showing, so the pixel comparator adjudicates the
    // wrong pair while every hash still matches.
    expect(argv()).toContain('-fps_mode')
    expect(argv()).toContain('passthrough')
    expect(argv()).toContain('-frames:v')
    expect(argv()).toContain('1')
  })

  it('brackets the requested PTS tightly rather than seeking near it', () => {
    const filter = argv().find((a: string) => a.startsWith('select=between'))
    expect(filter).toBeTruthy()
    expect(filter).toContain('12.345677')
    expect(filter).toContain('12.345679')
  })
})

describe('OCR integer recovery', () => {
  it('normalises the glyphs OCR confuses with zero', () => {
    expect(parseOcrInteger('1o')).toBe(10)
    expect(parseOcrInteger('1ø')).toBe(10)
    expect(parseOcrInteger('1Ø')).toBe(10)
    expect(parseOcrInteger('1e')).toBe(10)
  })

  it('returns null for anything not an integer', () => {
    expect(parseOcrInteger('12.5')).toBeNull()
    expect(parseOcrInteger('')).toBeNull()
    expect(parseOcrInteger(undefined)).toBeNull()
  })
})

describe('HUD parsing reads every counter the outcome claims', () => {
  const hud = {
    texts: [
      '00:01:23.456',
      'PLAY',
      'drop 0 held 2 shown 300 cache 120 tex 8',
      'play 1 rss 512.5 MB'
    ],
    stdoutSha256: 'b'.repeat(64)
  }

  it('extracts timecode, transport state and all five diagnostics', () => {
    const parsed = parseVisibleHud(hud, 'asset-1', { matchAsset: () => ({ matched: true }) })
    expect(parsed.contentPtsSeconds).toBeCloseTo(83.456, 3)
    expect(parsed.state).toBe('PLAY')
    expect(parsed.diagnostics).toEqual({
      droppedFrames: 0,
      heldFrames: 2,
      shownFrames: 300,
      cacheHits: 120,
      textures: 8
    })
    expect(parsed.players).toEqual({ count: 1, rssMegabytes: 512.5 })
  })

  it('reports a missing timecode as null rather than zero', () => {
    // Zero is a legitimate playhead position. Coercing "unreadable" to 0 would let
    // an unreadable HUD pass the >= 0 validity check.
    const parsed = parseVisibleHud({ texts: ['PLAY'], stdoutSha256: 'c'.repeat(64) }, 'a', {
      matchAsset: () => ({ matched: false })
    })
    expect(parsed.contentPtsSeconds).toBeNull()
  })
})

describe('sample validity gates on visible, advancing, matched playback', () => {
  const valid = {
    contentPtsSeconds: 10,
    state: 'PLAY',
    assetMatch: { matched: true },
    diagnostics: { droppedFrames: 0, heldFrames: 1, shownFrames: 300, cacheHits: 10, textures: 4 },
    players: { count: 1, rssMegabytes: 400 }
  }

  it('accepts a truthful advancing sample', () => {
    expect(isPlayableSample(valid, 5).valid).toBe(true)
  })

  it('rejects a paused sample even when every counter is readable', () => {
    expect(isPlayableSample({ ...valid, state: 'PAUSE' }, 5).valid).toBe(false)
  })

  it('rejects a sample whose asset does not match the opened media', () => {
    expect(isPlayableSample({ ...valid, assetMatch: { matched: false } }, 5).valid).toBe(false)
  })

  it('rejects a stalled playhead', () => {
    expect(isPlayableSample(valid, 10).valid).toBe(false)
  })

  it('rejects an unreadable counter rather than treating it as zero', () => {
    const blind = { ...valid, diagnostics: { ...valid.diagnostics, shownFrames: null } }
    expect(isPlayableSample(blind, 5).valid).toBe(false)
  })
})

describe('assertDiagnostics is the Outcome 9 claim, and it must reject each way it can be false', () => {
  it('accepts a truthful series and reports the derived rate', () => {
    const verdict = assertDiagnostics(truthfulSeries(), resources(500_000), resources(520_000))
    expect(verdict.droppedFramesStayedZero).toBe(true)
    expect(verdict.presentedRate).toBeCloseTo(30, 5)
    expect(verdict.rssAgreement.withinTolerance).toBe(true)
  })

  it('rejects a nonzero visible dropped-frame counter', () => {
    const series = truthfulSeries()
    series[1].observed.diagnostics.droppedFrames = 1
    expect(() => assertDiagnostics(series, resources(500_000), resources(520_000))).toThrow(
      /dropped-frame/i
    )
  })

  it('rejects a playhead that does not advance between samples', () => {
    const series = truthfulSeries()
    series[1].observed.contentPtsSeconds = 10
    expect(() => assertDiagnostics(series, resources(500_000), resources(520_000))).toThrow(
      /monotonic/i
    )
  })

  it('rejects shown frames that stall while the playhead moves', () => {
    // This is the "video is frozen but the clock runs" failure - the exact thing a
    // screenshot alone cannot distinguish from healthy playback.
    const series = truthfulSeries()
    series[1].observed.diagnostics.shownFrames = 300
    expect(() => assertDiagnostics(series, resources(500_000), resources(520_000))).toThrow(
      /monotonic/i
    )
  })

  it('rejects a cache-hit counter that moves backwards', () => {
    const series = truthfulSeries()
    series[1].observed.diagnostics.cacheHits = 1
    expect(() => assertDiagnostics(series, resources(500_000), resources(520_000))).toThrow(
      /monotonic/i
    )
  })

  it('rejects a presented rate outside the plausible band', () => {
    const series = truthfulSeries()
    series[1].observed.diagnostics.shownFrames = 300 + 5 // 0.5 fps over 10s
    expect(() => assertDiagnostics(series, resources(500_000), resources(520_000))).toThrow(/rate/i)
  })

  it('rejects a visible RSS that disagrees with the exact process sample', () => {
    // The HUD could render a plausible constant. Cross-checking it against `ps` for
    // the exact pid is what makes the number evidence rather than decoration.
    const series = truthfulSeries()
    expect(() => assertDiagnostics(series, resources(500_000), resources(4_000_000))).toThrow(
      /rss/i
    )
  })

  it('states its rate band as literals rather than deriving them from itself', () => {
    // A control that reads the same constant the implementation reads is a
    // tautology: shrink the constant and the control shrinks with it.
    expect(DIAGNOSTICS_PRESENTED_RATE_BOUNDS).toEqual({ minimum: 20, maximum: 90 })
  })
})

describe('assertDiagnostics validates every counter it claims to have read', () => {
  // WHY THIS BLOCK EXISTS. assertDiagnostics is documented as THE Outcome 9 claim,
  // but it originally read five diagnostics fields and only ever *checked* three -
  // and those three rejected an unreadable value by COERCION ACCIDENT rather than
  // by validation: null !== 0 tripped the dropped-frame gate, null <= null tripped
  // monotonicity, null < 1 tripped the player bound. Two fields (heldFrames,
  // textures) were never examined at all, cacheHits slipped through because
  // null < null is false, and an unreadable RSS passed whenever the process
  // footprint was small enough for the tolerance to swallow it.
  //
  // That is the exact false-Green shape this arc keeps paying for: the verdict
  // object reported the counters as evidence while the claim never required them
  // to be readable. A HUD that renders blanks would have produced a truthful-
  // looking Green.
  const series = (over: Record<string, unknown> = {}) => [
    observation(over),
    observation({
      contentPtsText: '00:00:20.000',
      contentPtsSeconds: 20,
      ...over,
      diagnostics: {
        droppedFrames: 0,
        heldFrames: 3,
        shownFrames: 600,
        cacheHits: 240,
        textures: 8,
        ...((over.diagnostics as Record<string, unknown>) || {})
      }
    })
  ]

  // Literal per-field controls. Named individually so a regression names the field
  // rather than reporting "assertDiagnostics failed".
  for (const field of ['droppedFrames', 'heldFrames', 'shownFrames', 'cacheHits', 'textures']) {
    it('rejects a sample whose ' + field + ' counter could not be read', () => {
      expect(() =>
        assertDiagnostics(
          series({ diagnostics: { [field]: null } }),
          resources(500_000),
          resources(520_000)
        )
      ).toThrow(/unreadable/i)
    })
  }

  it('rejects an unreadable player count', () => {
    expect(() =>
      assertDiagnostics(
        series({ players: { count: null } }),
        resources(500_000),
        resources(520_000)
      )
    ).toThrow(/unreadable/i)
  })

  it('rejects an unreadable visible RSS even when a small process footprint would mask it', () => {
    // The nastiest of the set: with a large process RSS the tolerance check happened
    // to reject this, so it looked guarded. At ~60MB the tolerance floor of 64MB
    // swallows the difference and the unreadable value passes. A gate that only
    // holds for large processes is not a gate.
    expect(() =>
      assertDiagnostics(
        series({ players: { rssMegabytes: null } }),
        resources(500_000),
        resources(61_440)
      )
    ).toThrow(/unreadable/i)
  })

  it('rejects a counter OCR returned as text rather than a number', () => {
    expect(() =>
      assertDiagnostics(
        series({ diagnostics: { heldFrames: 'eight' } }),
        resources(500_000),
        resources(520_000)
      )
    ).toThrow(/unreadable/i)
  })

  it('rejects a negative counter, which no frame tally can legitimately be', () => {
    expect(() =>
      assertDiagnostics(
        series({ diagnostics: { heldFrames: -1 } }),
        resources(500_000),
        resources(520_000)
      )
    ).toThrow(/unreadable/i)
  })

  it('rejects a fractional frame counter', () => {
    expect(() =>
      assertDiagnostics(
        series({ diagnostics: { textures: 1.5 } }),
        resources(500_000),
        resources(520_000)
      )
    ).toThrow(/unreadable/i)
  })

  it('rejects an absurd OCR-inflated RSS rather than trusting the digits', () => {
    expect(() =>
      assertDiagnostics(
        series({ players: { rssMegabytes: 99_999_999 } }),
        resources(500_000),
        resources(520_000)
      )
    ).toThrow(/unreadable/i)
  })

  it('states the RSS ceiling as a literal rather than reading the constant back', () => {
    expect(DIAGNOSTICS_VISIBLE_RSS_CEILING_MEGABYTES).toBe(1_048_576)
  })

  it('requires exactly the five counters the verdict reports, no fewer and no more', () => {
    // The per-field controls above iterate a list written out LITERALLY in this
    // file, so shrinking the implementation constant cannot silently shrink
    // coverage. This asserts the constant equals that literal list, which also
    // catches a counter being ADDED to the verdict without a legibility control.
    expect(REQUIRED_VISIBLE_COUNTERS).toEqual([
      'droppedFrames',
      'heldFrames',
      'shownFrames',
      'cacheHits',
      'textures'
    ])
  })

  it('still accepts the truthful series, so the new gate is not simply refusing everything', () => {
    // A control that reds for ANY reason is indistinguishable from a working one.
    const verdict = assertDiagnostics(series(), resources(500_000), resources(520_000))
    expect(verdict.presentedRate).toBeCloseTo(30, 5)
    expect(verdict.droppedFramesStayedZero).toBe(true)
  })
})

describe('assertDiagnostics validates every truth its verdict reports, not only the counters', () => {
  // SECOND GENERALIZATION, AND THE LESSON IS MINE. The previous pass hardened the
  // seven visible counters and stopped there - so the playhead, the player-count
  // stability claim, the asset identity and the serialized resource deltas were
  // still unvalidated. "Probe the whole class" has to mean the class of things the
  // VERDICT ASSERTS, not the class of fields that happened to be in the last loop.
  //
  // The severe one is asset identity: assertDiagnostics never checked assetMatch,
  // so the entire Outcome 9 claim could have been satisfied by samples of
  // completely different media while every counter advanced beautifully.
  const at = (pts: unknown, shown: number, cache: number, over: Record<string, unknown> = {}) => ({
    observed: {
      contentPtsText: 'x',
      contentPtsSeconds: pts,
      state: 'PLAY',
      assetMatch: { matched: true },
      rawOcrSha256: 'a'.repeat(64),
      diagnostics: {
        droppedFrames: 0,
        heldFrames: 2,
        shownFrames: shown,
        cacheHits: cache,
        textures: 8
      },
      players: { count: 1, rssMegabytes: 512 },
      ...over
    }
  })
  const pair = (over: Record<string, unknown> = {}) => [
    at(10, 300, 120, over),
    at(20, 600, 240, over)
  ]
  const R = (over: Record<string, unknown> = {}) => ({ ...resources(520_000), ...over })

  describe('the playhead', () => {
    it('rejects a playhead OCR returned as text, which coerces into a truthful-looking rate', () => {
      // '20' - '10' is 10 and 300/10 is 30, so every arithmetic claim downstream
      // reads correct while nothing numeric was ever measured.
      expect(() => assertDiagnostics([at('10', 300, 120), at('20', 600, 240)], R(), R())).toThrow(
        /playhead/i
      )
    })

    it('rejects a negative playhead, which no transport position can be', () => {
      expect(() => assertDiagnostics([at(-20, 300, 120), at(-10, 600, 240)], R(), R())).toThrow(
        /playhead/i
      )
    })

    it('rejects an unreadable playhead by validation rather than by coercion', () => {
      expect(() => assertDiagnostics([at(null, 300, 120), at(null, 600, 240)], R(), R())).toThrow(
        /playhead/i
      )
    })

    it('rejects a non-finite playhead', () => {
      expect(() => assertDiagnostics([at(10, 300, 120), at(Infinity, 600, 240)], R(), R())).toThrow(
        /playhead/i
      )
      expect(() => assertDiagnostics([at(NaN, 300, 120), at(NaN, 600, 240)], R(), R())).toThrow(
        /playhead/i
      )
    })

    it('rejects a playhead beyond the generated fixture duration', () => {
      expect(() => assertDiagnostics([at(10, 300, 120), at(601, 600, 240)], R(), R())).toThrow(
        /playhead/i
      )
    })
  })

  describe('the playerCountStable claim', () => {
    it('rejects an intermediate player-count drift the first/last comparison misses', () => {
      // 1 -> 2 -> 1 leaves first === last, so the verdict reported
      // playerCountStable:true while a second player existed mid-run - exactly the
      // shared-decoder violation this claim is supposed to detect.
      const samples = [
        at(10, 300, 120),
        at(20, 600, 240, { players: { count: 2, rssMegabytes: 512 } }),
        at(30, 900, 360)
      ]
      expect(() => assertDiagnostics(samples, R(), R())).toThrow(/player count/i)
    })

    it('rejects an intermediate player count outside the permitted bound', () => {
      const samples = [
        at(10, 300, 120),
        at(20, 600, 240, { players: { count: 7, rssMegabytes: 512 } }),
        at(30, 900, 360)
      ]
      expect(() => assertDiagnostics(samples, R(), R())).toThrow(/player count/i)
    })

    it('accepts a genuinely stable three-sample series', () => {
      const verdict = assertDiagnostics(
        [at(10, 300, 120), at(20, 600, 240), at(30, 900, 360)],
        R(),
        R()
      )
      expect(verdict.playerCountStable).toBe(true)
    })
  })

  describe('asset identity - the claim must be about the opened media', () => {
    it('rejects samples that do not show the opened asset', () => {
      // THE SEVERE ONE. Without this, Outcome 9 could be satisfied by screenshots
      // of entirely different media with perfectly advancing counters.
      expect(() => assertDiagnostics(pair({ assetMatch: { matched: false } }), R(), R())).toThrow(
        /opened asset/i
      )
    })

    it('rejects a sample with no asset determination at all', () => {
      expect(() => assertDiagnostics(pair({ assetMatch: undefined }), R(), R())).toThrow(
        /opened asset/i
      )
    })
  })

  describe('observation identity', () => {
    it('rejects a sample carrying no raw OCR digest, and reports the digests it relied on', () => {
      expect(() => assertDiagnostics(pair({ rawOcrSha256: null }), R(), R())).toThrow(
        /observation identity/i
      )
      const verdict = assertDiagnostics(pair(), R(), R())
      expect(verdict.observationIdentities).toHaveLength(2)
      expect(verdict.observationIdentities[0].rawOcrSha256).toBe('a'.repeat(64))
    })
  })

  describe('the serialized resource deltas', () => {
    for (const field of [
      'physicalFootprintBytes',
      'peakPhysicalFootprintBytes',
      'mallocAllocatedBytes',
      'iosurfaceVirtualBytes',
      'iosurfaceResidentBytes',
      'iosurfaceRegionCount'
    ]) {
      it('rejects a non-numeric ' + field + ' rather than serializing a coerced delta', () => {
        expect(() =>
          assertDiagnostics(pair(), R({ [field]: 'abc' }), R({ [field]: 'abc' }))
        ).toThrow(/resource sample/i)
      })
    }

    it('rejects a null resource field', () => {
      expect(() =>
        assertDiagnostics(
          pair(),
          R({ physicalFootprintBytes: null }),
          R({ physicalFootprintBytes: null })
        )
      ).toThrow(/resource sample/i)
    })

    it('rejects a non-numeric process RSS reading', () => {
      expect(() =>
        assertDiagnostics(
          pair(),
          R({ ps: { rssKilobytes: 'x' } }),
          R({ ps: { rssKilobytes: 'x' } })
        )
      ).toThrow(/resource sample/i)
    })

    it('requires exactly the resource fields the verdict serializes', () => {
      // Literal list here, equality asserted separately - so shrinking the
      // implementation constant cannot silently shrink this coverage.
      expect(REQUIRED_RESOURCE_FIELDS).toEqual([
        'physicalFootprintBytes',
        'peakPhysicalFootprintBytes',
        'mallocAllocatedBytes',
        'iosurfaceVirtualBytes',
        'iosurfaceResidentBytes',
        'iosurfaceRegionCount'
      ])
    })
  })

  it('still accepts a fully truthful series, so none of the above is refusing everything', () => {
    const verdict = assertDiagnostics(pair(), R(), R())
    expect(verdict.ptsAdvanced).toBe(true)
    expect(verdict.presentedRate).toBeCloseTo(30, 5)
    expect(verdict.resourceDelta.physicalFootprintBytes).toBe(0)
  })
})

describe('the runner is honest about what it cannot yet do', () => {
  // The session layer (withIsolatedSession, invokeStudioOpen, captureNative,
  // waitForSourceWindow, ocrScreenshot, resourceSample, focus isolation) is still
  // untracked. Rather than silently reaching into .local-only, an end-to-end run
  // must refuse and name what is missing. Shipping a runner that LOOKS runnable is
  // how an outcome gets promoted on apparatus nobody can reproduce.
  it('names the unpromoted session dependencies explicitly', () => {
    expect(UNPROMOTED_SESSION_DEPENDENCIES.length).toBeGreaterThan(0)
    expect(UNPROMOTED_SESSION_DEPENDENCIES).toContain('withIsolatedSession')
    expect(UNPROMOTED_SESSION_DEPENDENCIES).toContain('captureNative')
  })

  it('refuses an end-to-end run instead of pretending to observe', async () => {
    await expect(runBoundedDiagnostics()).rejects.toThrow(/not yet promoted/i)
  })

  it('names every missing dependency in the refusal, so the follow-up is unambiguous', async () => {
    const error = await runBoundedDiagnostics().catch((e: Error) => e)
    for (const dependency of UNPROMOTED_SESSION_DEPENDENCIES) {
      expect(String(error.message)).toContain(dependency)
    }
  })
})
