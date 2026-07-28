import { describe, expect, it } from 'vitest'
import {
  buildCreativeAppCapabilitySnapshot,
  buildCreativeAppStatusSnapshot,
  buildCreativeProjectSnapshot,
  buildFcpxmlTimelineDiffPlan,
  buildFcpxmlTimelineIr,
  canonicalizeFcpxmlTime,
  getSequenceCanonicalDenominator,
  isCreativeAppId,
  listCreativeAppBundleIds,
  parseFcpxmlTime,
  serializeFcpxmlTimelineIr,
  validateFcpxml,
  type FcpxmlTimelineIr
} from './CreativeAppAdapters'

describe('CreativeAppAdapters', () => {
  it('lists the initial supported creative apps', () => {
    const snapshot = buildCreativeAppStatusSnapshot({
      now: '2026-05-23T00:00:00.000Z',
      fileExists: () => false
    })

    expect(snapshot.generatedAt).toBe('2026-05-23T00:00:00.000Z')
    expect(snapshot.apps.map((app) => app.id)).toEqual(['final-cut-pro', 'logic-pro', 'blender'])
    expect(snapshot.apps.every((app) => app.capabilityCount > 0)).toBe(true)
  })

  it('marks the matching user-attached window without enumerating other windows', () => {
    const snapshot = buildCreativeAppStatusSnapshot({
      attachedWindow: {
        title: 'My Scene.blend',
        bundleID: 'org.blenderfoundation.blender',
        applicationName: 'Blender'
      },
      fileExists: () => false
    })

    const blender = snapshot.apps.find((app) => app.id === 'blender')
    const logic = snapshot.apps.find((app) => app.id === 'logic-pro')

    expect(blender?.attached).toBe(true)
    expect(blender?.attachedWindow).toEqual({
      title: 'My Scene.blend',
      bundleID: 'org.blenderfoundation.blender',
      applicationName: 'Blender'
    })
    expect(logic?.attached).toBe(false)
    expect(logic?.attachedWindow).toBeUndefined()
  })

  it('filters detailed capabilities by app id', () => {
    const snapshot = buildCreativeAppCapabilitySnapshot({
      appId: 'final-cut-pro',
      fileExists: (path) => path === '/Applications/Final Cut Pro.app'
    })

    expect(snapshot.apps).toHaveLength(1)
    expect(snapshot.apps[0].id).toBe('final-cut-pro')
    expect(snapshot.apps[0].installedHint).toBe(true)
    expect(snapshot.apps[0].capabilities.map((capability) => capability.id)).toContain(
      'fcpxml-patch-plan'
    )
    expect(snapshot.apps[0].prompts).toContain('shot_list_to_fcpxml')
  })

  it('validates creative app ids', () => {
    expect(isCreativeAppId('logic-pro')).toBe(true)
    expect(isCreativeAppId('premiere-pro')).toBe(false)
  })

  it('summarizes FCPXML without mutating the source document', () => {
    const snapshot = buildCreativeProjectSnapshot({
      path: 'edit.fcpxml',
      isDirectory: false,
      text: `
        <fcpxml version="1.14">
          <resources><asset id="r1" /><effect id="e1" /></resources>
          <library><event><project><sequence><spine><asset-clip /><marker /></spine></sequence></project></event></library>
        </fcpxml>
      `
    })

    expect(snapshot.appId).toBe('final-cut-pro')
    expect(snapshot.kind).toBe('fcpxml')
    expect(snapshot.readOnly).toBe(true)
    expect(snapshot.stats.version).toBe('1.14')
    expect(snapshot.stats.assets).toBe(1)
    expect(snapshot.stats.projects).toBe(1)
    expect(snapshot.stats.markers).toBe(1)
  })

  it('summarizes MIDI headers for Logic file workflows', () => {
    const snapshot = buildCreativeProjectSnapshot({
      path: 'cue.mid',
      isDirectory: false,
      bytes: new Uint8Array([
        0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x02, 0x01, 0xe0
      ])
    })

    expect(snapshot.appId).toBe('logic-pro')
    expect(snapshot.kind).toBe('midi')
    expect(snapshot.stats.validHeader).toBe(true)
    expect(snapshot.stats.format).toBe(1)
    expect(snapshot.stats.tracks).toBe(2)
  })

  it('treats app packages as metadata-only snapshots', () => {
    const snapshot = buildCreativeProjectSnapshot({
      path: 'Project.logicx',
      isDirectory: true,
      sizeBytes: 4096
    })

    expect(snapshot.appId).toBe('logic-pro')
    expect(snapshot.kind).toBe('logic-package')
    expect(snapshot.stats.directory).toBe(true)
    expect(snapshot.warnings[0]).toContain('.logicx internals')
  })

  it('validates clean FCPXML with lightweight checks', () => {
    const result = validateFcpxml({
      path: 'edit.fcpxml',
      text: `
        <fcpxml version="1.14">
          <resources><asset id="r1" src="file:///clip.mov" /></resources>
          <library><event><project><sequence><spine><asset-clip ref="r1" /></spine></sequence></project></event></library>
        </fcpxml>
      `
    })

    expect(result.valid).toBe(true)
    expect(result.version).toBe('1.14')
    expect(result.issueCounts.error).toBe(0)
    expect(result.stats.assets).toBe(1)
  })

  it('flags duplicate ids and unresolved refs in FCPXML', () => {
    const result = validateFcpxml({
      path: 'broken.fcpxml',
      text: `
        <fcpxml version="1.14">
          <resources><asset id="r1" /><asset id="r1" /></resources>
          <library><event><project><sequence><spine><asset-clip ref="missing" /></spine></sequence></project></event></library>
        </fcpxml>
      `
    })

    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toContain('duplicate-id')
    expect(result.issues.map((issue) => issue.code)).toContain('unresolved-ref')
  })

  it('parses FCPXML into a compact timeline IR', () => {
    const result = buildFcpxmlTimelineIr({
      path: 'edit.fcpxml',
      text: `
        <fcpxml version="1.14">
          <resources>
            <format id="fmt1" name="FFVideoFormat1080p30" width="1920" height="1080" />
            <asset id="r1" name="Interview" uid="abc" src="file:///interview.mov" duration="10s" />
            <effect id="title1" name="Basic Title" uid=".../Titles.localized/Basic Title" />
          </resources>
          <library>
            <event name="Day 1">
              <project name="Assembly">
                <sequence format="fmt1" duration="10s" tcStart="0s">
                  <spine>
                    <asset-clip name="Interview clip" ref="r1" offset="0s" duration="10s">
                      <marker start="1s" value="Intro" />
                      <caption start="2s" duration="1s" role="caption" />
                    </asset-clip>
                    <title name="Lower third" ref="title1" offset="3s" duration="2s" />
                  </spine>
                </sequence>
              </project>
            </event>
          </library>
        </fcpxml>
      `
    })

    expect(result.ir).toBe('fcpxml-timeline-ir-v1')
    expect(result.version).toBe('1.14')
    expect(result.resources.assets[0].name).toBe('Interview')
    expect(result.resources.formats[0].width).toBe('1920')
    expect(result.projects[0].eventName).toBe('Day 1')
    expect(result.projects[0].sequence?.format).toBe('fmt1')
    expect(result.projects[0].sequence?.spine).toHaveLength(2)
    expect(result.projects[0].sequence?.spine[0].refName).toBe('Interview')
    expect(result.projects[0].sequence?.spine[0].markers[0].value).toBe('Intro')
    expect(result.projects[0].sequence?.spine[0].captions).toHaveLength(1)
    expect(result.projects[0].sequence?.spine[1].refName).toBe('Basic Title')
  })

  it('builds a read-only FCPXML diff plan with sidecar payload', () => {
    const beforeText = `
      <fcpxml version="1.14">
        <resources>
          <format id="fmt1" width="1920" height="1080" />
          <asset id="r1" name="Interview" uid="abc" src="file:///interview.mov" duration="10s" />
          <asset id="r2" name="B-roll" uid="def" src="file:///broll.mov" duration="4s" />
          <effect id="title1" name="Basic Title" uid=".../Titles.localized/Basic Title" />
        </resources>
        <library>
          <event name="Day 1">
            <project name="Assembly">
              <sequence format="fmt1" duration="10s">
                <spine>
                  <asset-clip name="Interview clip" ref="r1" offset="0s" duration="10s" />
                  <title name="Lower third" ref="title1" offset="3s" duration="2s" />
                </spine>
              </sequence>
            </project>
          </event>
        </library>
      </fcpxml>
    `
    const afterText = `
      <fcpxml version="1.14">
        <resources>
          <format id="fmt1" width="1920" height="1080" />
          <asset id="r1" name="Interview" uid="abc" src="file:///interview.mov" duration="10s" />
          <asset id="r2" name="B-roll" uid="def" src="file:///broll.mov" duration="4s" />
          <effect id="title1" name="Basic Title" uid=".../Titles.localized/Basic Title" />
        </resources>
        <library>
          <event name="Day 1">
            <project name="Assembly">
              <sequence format="fmt1" duration="12s">
                <spine>
                  <asset-clip name="Interview clip" ref="r1" offset="0s" duration="8s" />
                  <title name="Lower third" ref="title1" offset="3s" duration="3s" />
                  <asset-clip name="B-roll cutaway" ref="r2" offset="8s" duration="4s" />
                </spine>
              </sequence>
            </project>
          </event>
        </library>
      </fcpxml>
    `

    const result = buildFcpxmlTimelineDiffPlan({
      beforePath: 'original.fcpxml',
      beforeText,
      afterPath: 'draft.fcpxml',
      afterText,
      now: '2026-05-23T10:00:00.000Z'
    })

    expect(result.diff).toBe('fcpxml-timeline-diff-v1')
    expect(result.summary.addedItemCount).toBe(1)
    expect(result.summary.changedItemCount).toBe(2)
    expect(result.projects[0].fields).toContain('sequence.duration')
    expect(result.projects[0].addedItems[0].refName).toBe('B-roll')
    expect(result.projects[0].changedItems[0].fields).toContain('duration')
    expect(result.affectedResources.assets.map((asset) => asset.name)).toEqual([
      'B-roll',
      'Interview'
    ])
    expect(result.affectedResources.effects[0].name).toBe('Basic Title')
    expect(result.sidecar.recommendedPath).toBe('draft.fcpxml.taskwraith-timeline-diff.json')
    expect(result.sidecar.document).toMatchObject({
      schema: 'taskwraith-fcpxml-diff-plan-v1',
      beforePath: 'original.fcpxml',
      afterPath: 'draft.fcpxml'
    })
  })

  // Phase K1 — running-process probe.
  describe('runningHint (K1)', () => {
    it('exposes every declared bundle id via listCreativeAppBundleIds', () => {
      const ids = listCreativeAppBundleIds()
      expect(ids).toContain('com.apple.FinalCut')
      expect(ids).toContain('com.apple.logic10')
      expect(ids).toContain('org.blenderfoundation.blender')
      // Set semantics — no duplicates.
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('defaults runningHint to false when no predicate is supplied', () => {
      const snapshot = buildCreativeAppStatusSnapshot({ fileExists: () => true })
      for (const app of snapshot.apps) {
        expect(app.runningHint).toBe(false)
      }
    })

    it('flips runningHint to true when the predicate returns true for any declared bundle id', () => {
      const snapshot = buildCreativeAppStatusSnapshot({
        fileExists: () => true,
        runningHint: (bundleId) => bundleId === 'com.apple.FinalCut'
      })
      const fcp = snapshot.apps.find((app) => app.id === 'final-cut-pro')
      const logic = snapshot.apps.find((app) => app.id === 'logic-pro')
      const blender = snapshot.apps.find((app) => app.id === 'blender')
      expect(fcp?.runningHint).toBe(true)
      expect(logic?.runningHint).toBe(false)
      expect(blender?.runningHint).toBe(false)
    })

    it('keeps installedHint and runningHint orthogonal — installed-but-quit and quit-but-running are both representable', () => {
      // Installed but not running (app on disk, quit): installedHint=true, runningHint=false.
      const installedQuiet = buildCreativeAppStatusSnapshot({
        appId: 'final-cut-pro',
        fileExists: (path) => path === '/Applications/Final Cut Pro.app',
        runningHint: () => false
      })
      expect(installedQuiet.apps[0].installedHint).toBe(true)
      expect(installedQuiet.apps[0].runningHint).toBe(false)
      // Running but on a non-/Applications path (less common, but possible
      // for sideloaded copies): installedHint=false, runningHint=true.
      // The agent sees "running without a known disk hint" — useful signal.
      const runningElsewhere = buildCreativeAppStatusSnapshot({
        appId: 'final-cut-pro',
        fileExists: () => false,
        runningHint: () => true
      })
      expect(runningElsewhere.apps[0].installedHint).toBe(false)
      expect(runningElsewhere.apps[0].runningHint).toBe(true)
    })

    it('propagates runningHint into the capabilities snapshot too', () => {
      const snapshot = buildCreativeAppCapabilitySnapshot({
        appId: 'blender',
        fileExists: () => true,
        runningHint: (bundleId) => bundleId === 'org.blenderfoundation.blender'
      })
      expect(snapshot.apps[0].runningHint).toBe(true)
    })
  })

  // Phase K2 — FCPXML writer round-trip.
  describe('serializeFcpxmlTimelineIr (K2)', () => {
    it('emits a minimal valid FCPXML skeleton from an empty IR', () => {
      const result = serializeFcpxmlTimelineIr({ ir: {} })
      expect(result.ok).toBe(true)
      expect(result.text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
      expect(result.text).toContain('<!DOCTYPE fcpxml>')
      expect(result.text).toContain('<fcpxml version="1.13">')
      expect(result.text).toContain('<resources>')
      // No <library> when no projects — keeps the doc minimal and importable.
      expect(result.text).not.toContain('<library>')
      expect(result.text).toMatch(/<\/fcpxml>\n$/)
      expect(result.summary.assetCount).toBe(0)
      expect(result.summary.projectCount).toBe(0)
    })

    it('round-trips a representative IR through emit → parse without losing structural fields', () => {
      const ir: FcpxmlTimelineIr = {
        ok: true,
        generatedAt: '2026-05-23T00:00:00.000Z',
        appId: 'final-cut-pro',
        path: 'edit.fcpxml',
        kind: 'fcpxml',
        readOnly: true,
        ir: 'fcpxml-timeline-ir-v1',
        version: '1.13',
        resources: {
          // Phase K8 — use a 30fps (1/30s frame duration) fixture
          // so the round-trip test stays focused on structural
          // fidelity. K8 canonicalization scales 60s → 1800/30s at
          // 30fps, which the test asserts below. (At 29.97 NDF, 60s
          // is NOT actually frame-aligned — that's a real-world
          // edge case the frame-boundary preflight catches.)
          formats: [
            {
              id: 'r1',
              name: 'FFVideoFormat1080p30',
              width: '1920',
              height: '1080',
              frameDuration: '1/30s'
            }
          ],
          assets: [
            {
              id: 'r2',
              name: 'B-roll',
              uid: 'ABC123',
              src: 'file:///Users/dev/Movies/broll.mov',
              duration: '120s',
              start: '0s',
              format: 'r1'
            }
          ],
          effects: [{ id: 'r3', name: 'Basic Title', uid: '.../Titles.localized/Basic Title.moef' }]
        },
        projects: [
          {
            name: 'My Edit',
            eventName: 'Phase K shoot',
            sequence: {
              name: 'My Edit',
              duration: '180s',
              format: 'r1',
              tcStart: '0s',
              tcFormat: 'NDF',
              spine: [
                {
                  index: 0,
                  type: 'asset-clip',
                  name: 'Opening shot',
                  ref: 'r2',
                  refName: 'B-roll',
                  offset: '0s',
                  start: '0s',
                  duration: '60s',
                  role: 'video',
                  markers: [
                    {
                      type: 'marker',
                      start: '15s',
                      duration: '1/30000s',
                      value: 'beat drop',
                      note: 'cymbal hit'
                    }
                  ],
                  captions: [
                    {
                      type: 'caption',
                      start: '5s',
                      duration: '3s',
                      value: 'Hello world',
                      role: 'iTT'
                    }
                  ]
                },
                {
                  index: 1,
                  type: 'gap',
                  name: undefined,
                  offset: '60s',
                  duration: '2s',
                  markers: [],
                  captions: []
                }
              ],
              markers: [
                {
                  type: 'chapter-marker',
                  start: '0s',
                  duration: '1/30000s',
                  value: 'Chapter 1'
                }
              ]
            }
          }
        ],
        summary: {},
        warnings: []
      }
      const writer = serializeFcpxmlTimelineIr({ ir })
      expect(writer.summary.timelineItemCount).toBe(2)
      // Reparse — the IR builder should reconstitute the same structural shape.
      const reparsed = buildFcpxmlTimelineIr({ path: 'roundtrip.fcpxml', text: writer.text })
      expect(reparsed.version).toBe('1.13')
      expect(reparsed.resources.assets.map((asset) => asset.id)).toEqual(['r2'])
      expect(reparsed.resources.assets[0].name).toBe('B-roll')
      expect(reparsed.resources.assets[0].src).toBe('file:///Users/dev/Movies/broll.mov')
      expect(reparsed.resources.formats[0].frameDuration).toBe('1/30s')
      expect(reparsed.resources.effects[0].name).toBe('Basic Title')
      expect(reparsed.projects).toHaveLength(1)
      const project = reparsed.projects[0]
      expect(project.name).toBe('My Edit')
      expect(project.eventName).toBe('Phase K shoot')
      expect(project.sequence?.spine).toHaveLength(2)
      expect(project.sequence?.spine[0].type).toBe('asset-clip')
      expect(project.sequence?.spine[0].name).toBe('Opening shot')
      expect(project.sequence?.spine[0].ref).toBe('r2')
      // K8 — writer canonicalized 60s → 1800/30s against the sequence's
      // format frame duration (1/30s). Mathematically identical, but
      // FCP doesn't simplify rationals before checking frame alignment,
      // so the explicit shared denominator silences the warning.
      expect(project.sequence?.spine[0].duration).toBe('1800/30s')
      expect(project.sequence?.spine[0].markers).toHaveLength(1)
      expect(project.sequence?.spine[0].markers[0].value).toBe('beat drop')
      expect(project.sequence?.spine[0].captions).toHaveLength(1)
      expect(project.sequence?.spine[0].captions[0].value).toBe('Hello world')
      expect(project.sequence?.spine[1].type).toBe('gap')
      expect(project.sequence?.spine[1].duration).toBe('60/30s')
      // Sequence-level markers in the parser use recursive `descendants()`
      // so the count is "all marker-like elements in the subtree" — the
      // chapter-marker we put at sequence level plus the marker+caption
      // inside the clip. That's pre-existing parser behavior, not a
      // writer concern. We just assert the chapter-marker we emitted
      // round-trips into the set.
      const chapterMarkers = (project.sequence?.markers || []).filter(
        (m) => m.type === 'chapter-marker'
      )
      expect(chapterMarkers).toHaveLength(1)
      expect(chapterMarkers[0].value).toBe('Chapter 1')
    })

    it('escapes XML metacharacters in attribute values', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            assets: [
              {
                id: 'r1',
                name: 'Title with <special> & "quotes" \'apostrophes\'',
                src: 'file:///path/with&amp;.mov'
              }
            ]
          }
        }
      })
      // Verify entities, not raw chars. The doc must still be parseable.
      expect(writer.text).toContain('&lt;special&gt;')
      expect(writer.text).toContain('&amp;')
      expect(writer.text).toContain('&quot;quotes&quot;')
      expect(writer.text).toContain('&apos;apostrophes&apos;')
      // And it round-trips back to the original strings.
      const reparsed = buildFcpxmlTimelineIr({ path: 'esc.fcpxml', text: writer.text })
      expect(reparsed.resources.assets[0].name).toBe(
        'Title with <special> & "quotes" \'apostrophes\''
      )
    })

    it('preserves spine item ordering across emit/parse', () => {
      const ir: FcpxmlTimelineIr['projects'][number] = {
        name: 'order-test',
        sequence: {
          spine: [
            { index: 0, type: 'asset-clip', name: 'A', markers: [], captions: [] },
            { index: 1, type: 'gap', markers: [], captions: [] },
            { index: 2, type: 'asset-clip', name: 'B', markers: [], captions: [] },
            { index: 3, type: 'title', name: 'C', markers: [], captions: [] }
          ],
          markers: []
        }
      }
      const writer = serializeFcpxmlTimelineIr({ ir: { projects: [ir] } })
      const reparsed = buildFcpxmlTimelineIr({ path: 'order.fcpxml', text: writer.text })
      const names = reparsed.projects[0].sequence?.spine.map((s) => s.name || s.type)
      expect(names).toEqual(['A', 'gap', 'B', 'C'])
    })

    it('emits a <media-rep> child for every asset (DTD requires media-rep+)', () => {
      // Phase K7 — the FCPXML DTD declares
      //   <!ELEMENT asset (media-rep+, metadata?)>
      // i.e. every asset MUST carry at least one media-rep. Earlier
      // emission put src directly on <asset> and emitted no children,
      // which xmllint rejected as DTD-invalid even though FCP's
      // tolerant parser accepted it. The new shape moves src into a
      // nested <media-rep src="..."/> per the spec.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            assets: [{ id: 'r1', name: 'B-roll', src: 'file:///x.mov' }]
          }
        }
      })
      // The asset element opens (no self-close) and the media-rep
      // child sits inside it.
      expect(writer.text).toMatch(
        /<asset[^/]+id="r1"[^>]*>\s*\n\s*<media-rep[^>]+src="file:\/\/\/x\.mov"\s*\/>\s*\n\s*<\/asset>/
      )
      // Round-trip: the IR parser pulls src from the media-rep child.
      const reparsed = buildFcpxmlTimelineIr({ path: 'mr.fcpxml', text: writer.text })
      expect(reparsed.resources.assets[0].src).toBe('file:///x.mov')
      expect(reparsed.resources.assets[0].mediaRepCount).toBe(1)
    })

    it('synthesises a placeholder media-rep src when the IR asset has none', () => {
      // K7 — assets without src still need a media-rep child to satisfy
      // the DTD. We fill a workspace-placeholder URL so the doc remains
      // structurally valid; FCP shows the clip as offline media until
      // the asset is pointed at a real file.
      const writer = serializeFcpxmlTimelineIr({
        ir: { resources: { assets: [{ id: 'r1', name: 'Pending shoot' }] } }
      })
      expect(writer.text).toMatch(/<media-rep[^>]+src="file:\/\/\/taskwraith-placeholder\//)
      expect(writer.warnings.some((w) => /no src/.test(w))).toBe(true)
    })

    it('synthesises an empty sequence + spine when a project has no sequence (DTD: project requires sequence)', () => {
      // The K3 failure mode that surfaced this whole hardening pass:
      // FCP rejected the import with "expecting (sequence), got ()"
      // because our project element was empty. Writer now fills a
      // minimum-valid sequence so the document loads instead of
      // failing at the DTD layer.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', name: '1080p' }],
            assets: []
          },
          projects: [{ name: 'project-without-sequence' }]
        }
      })
      expect(writer.text).toMatch(/<sequence[^>]+format="r1"[^>]*>\s*\n\s*<spine\s*>\s*<\/spine>/)
      expect(writer.warnings.some((w) => /no sequence/.test(w))).toBe(true)
    })

    it('defaults sequence format ref to the first declared format when the IR omits it', () => {
      // DTD `%media_attrs;` declares `format` as #REQUIRED on
      // <sequence>. When the agent supplies a sequence but forgets
      // the format ref, fall back to the first format in resources
      // and warn so the agent learns.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [
              { id: 'r1', name: '1080p' },
              { id: 'r2', name: '4k' }
            ]
          },
          projects: [{ name: 'p', sequence: { spine: [], markers: [] } }]
        }
      })
      expect(writer.text).toMatch(/<sequence[^>]+format="r1"/)
      expect(writer.warnings.some((w) => /no format ref/.test(w))).toBe(true)
    })

    it('surfaces a warning when no <format> resources exist and sequence has no format ref', () => {
      // Worst case — no formats anywhere. We can't synthesise an
      // IDREF that points nowhere (xmllint will catch the dangling
      // ref) so we emit the sequence WITHOUT format attr and surface
      // a clear warning rather than producing a silently-invalid doc.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {},
          projects: [{ name: 'p', sequence: { spine: [], markers: [] } }]
        }
      })
      expect(writer.warnings.some((w) => /no <format> resources are declared/.test(w))).toBe(true)
    })

    it('warns when a spine item is missing duration (DTD #REQUIRED on gap)', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: { formats: [{ id: 'r1', name: '1080p' }] },
          projects: [
            {
              name: 'p',
              sequence: {
                spine: [
                  {
                    index: 0,
                    type: 'gap',
                    name: 'untimed',
                    markers: [],
                    captions: []
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.warnings.some((w) => /no duration/.test(w))).toBe(true)
    })

    it('synthesises an event name for projects without one so the doc validates', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: { projects: [{ name: 'untagged', eventName: undefined, sequence: undefined }] }
      })
      // The fallback name lives between the <event name="..."> attribute quotes.
      expect(writer.text).toMatch(/<event name="TaskWraith Drafts">/)
    })
  })

  // Phase K8 — time canonicalization (the Codex 5/4s warning fix).
  describe('parseFcpxmlTime / canonicalizeFcpxmlTime (K8)', () => {
    it('parses whole-second values', () => {
      expect(parseFcpxmlTime('5s')).toEqual({ num: 5, den: 1 })
      expect(parseFcpxmlTime('0s')).toEqual({ num: 0, den: 1 })
    })
    it('parses rational time values', () => {
      expect(parseFcpxmlTime('5/4s')).toEqual({ num: 5, den: 4 })
      expect(parseFcpxmlTime('1001/30000s')).toEqual({ num: 1001, den: 30000 })
    })
    it('returns null for unparseable input', () => {
      expect(parseFcpxmlTime(undefined)).toBeNull()
      expect(parseFcpxmlTime('')).toBeNull()
      expect(parseFcpxmlTime('not a time')).toBeNull()
      expect(parseFcpxmlTime('5/0s')).toBeNull() // zero denominator
    })

    it('canonicalizes simple times to a shared denominator', () => {
      // 5/4s scaled to denom 2400 → factor 600 → 3000/2400s.
      // This is the literal fix for the warnings we saw in Codex's
      // 4-segment split: 5/4s rejected, 3000/2400s accepted.
      expect(canonicalizeFcpxmlTime('5/4s', 2400)).toBe('3000/2400s')
      expect(canonicalizeFcpxmlTime('1s', 30)).toBe('30/30s')
      // 0s stays compact even after canonicalization.
      expect(canonicalizeFcpxmlTime('0s', 2400)).toBe('0s')
    })
    it('passes through when the target denom does not evenly divide', () => {
      // 1/7s can't be expressed cleanly in 2400ths (2400/7 ≈ 342.85),
      // so writer leaves it alone for the frame-boundary check to flag.
      expect(canonicalizeFcpxmlTime('1/7s', 2400)).toBe('1/7s')
    })
    it('passes through invalid inputs', () => {
      expect(canonicalizeFcpxmlTime(undefined, 2400)).toBe('')
      expect(canonicalizeFcpxmlTime('garbage', 2400)).toBe('garbage')
    })

    it('getSequenceCanonicalDenominator reads frameDuration from the referenced format', () => {
      expect(
        getSequenceCanonicalDenominator('r1', [{ id: 'r1', frameDuration: '100/2400s' }])
      ).toBe(2400)
      expect(getSequenceCanonicalDenominator('r1', [{ id: 'r1', frameDuration: '1/30s' }])).toBe(30)
      // Unknown ref or missing frameDuration → null (writer skips canon).
      expect(getSequenceCanonicalDenominator('missing', [])).toBeNull()
      expect(getSequenceCanonicalDenominator('r1', [{ id: 'r1' }])).toBeNull()
    })

    it('writer canonicalizes spine item times against the sequence format', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', name: '24p', frameDuration: '100/2400s' }],
            assets: [{ id: 'r2', name: 'clip', src: 'file:///x.mov' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                duration: '5s',
                format: 'r1',
                tcStart: '0s',
                spine: [
                  // The actual values from Codex's test that tripped
                  // the warnings — 5/4s segments at 24fps.
                  {
                    index: 0,
                    type: 'asset-clip',
                    name: 'A',
                    ref: 'r2',
                    offset: '0s',
                    start: '0s',
                    duration: '5/4s',
                    markers: [],
                    captions: []
                  },
                  {
                    index: 1,
                    type: 'asset-clip',
                    name: 'B',
                    ref: 'r2',
                    offset: '5/4s',
                    start: '5/4s',
                    duration: '5/4s',
                    markers: [],
                    captions: []
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      // Both clips should emit with the format's 2400 denominator.
      expect(writer.text).toContain('duration="3000/2400s"')
      expect(writer.text).toContain('offset="3000/2400s"')
      // Whole-second sequence duration also canonicalizes.
      expect(writer.text).toContain('duration="12000/2400s"')
      // No remaining /4s simplified forms.
      expect(writer.text).not.toContain('5/4s')
    })
  })

  // Phase K8 — title rich content round-trip.
  describe('serializeFcpxmlTimelineIr title text/style (K8)', () => {
    it('emits <text>, <text-style-def>, and <param> children when the title item carries them', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', name: '24p', frameDuration: '1/24s' }],
            effects: [
              { id: 'r3', name: 'Basic Title', uid: '.../Basic Title.localized/Basic Title.moti' }
            ]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                duration: '24/24s',
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'Hello there',
                    ref: 'r3',
                    offset: '0s',
                    duration: '24/24s',
                    lane: '1',
                    markers: [],
                    captions: [],
                    textRuns: [{ text: 'Hello there General Kenobi', styleRef: 'ts1' }],
                    textStyleDefs: [
                      {
                        id: 'ts1',
                        font: 'Comic Sans MS',
                        fontSize: '28',
                        fontFace: 'Regular',
                        alignment: 'center'
                      }
                    ],
                    titleParams: [{ name: 'Position', value: '0 0' }]
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toContain('<text>')
      expect(writer.text).toContain('<text-style ref="ts1">Hello there General Kenobi</text-style>')
      expect(writer.text).toContain('<text-style-def id="ts1">')
      expect(writer.text).toContain('font="Comic Sans MS"')
      expect(writer.text).toContain('fontSize="28"')
      expect(writer.text).toContain('alignment="center"')
      expect(writer.text).toContain('<param name="Position" value="0 0"/>')
    })

    it('round-trips title style defs + params back through the IR parser', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }],
            effects: [{ id: 'r3', name: 'Basic Title' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                duration: '24/24s',
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'Hi',
                    ref: 'r3',
                    offset: '0s',
                    duration: '24/24s',
                    markers: [],
                    captions: [],
                    textRuns: [{ text: 'Hi', styleRef: 'ts1' }],
                    textStyleDefs: [
                      { id: 'ts1', font: 'Helvetica', fontSize: '72', alignment: 'center' }
                    ],
                    titleParams: [{ name: 'Position', value: '0 -200' }]
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      const reparsed = buildFcpxmlTimelineIr({ path: 'title.fcpxml', text: writer.text })
      const titleItem = reparsed.projects[0].sequence?.spine[0]
      expect(titleItem?.type).toBe('title')
      expect(titleItem?.textStyleDefs).toBeDefined()
      expect(titleItem?.textStyleDefs?.[0].id).toBe('ts1')
      expect(titleItem?.textStyleDefs?.[0].font).toBe('Helvetica')
      expect(titleItem?.textStyleDefs?.[0].fontSize).toBe('72')
      expect(titleItem?.titleParams?.[0]).toEqual({
        name: 'Position',
        key: undefined,
        value: '0 -200'
      })
    })

    it('non-title items ignore the title-specific fields even when present', () => {
      // The IR's typed shape allows textRuns on any item, but the
      // writer only emits the children when type === 'title'. Lets
      // agents reuse generic IR builders without accidentally
      // sprinkling text/style children into asset-clip items.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }],
            assets: [{ id: 'r2', src: 'file:///x.mov' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'asset-clip',
                    ref: 'r2',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    // Should be ignored on emit:
                    textRuns: [{ text: 'should not appear' }],
                    textStyleDefs: [{ id: 'ts1', font: 'Arial' }]
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).not.toContain('should not appear')
      expect(writer.text).not.toContain('text-style-def')
    })
  })

  // Phase K8 — frame-boundary preflight in validateFcpxml.
  describe('validateFcpxml frame-boundary preflight (K8)', () => {
    it('flags spine items that are not on a frame boundary at the sequence rate', () => {
      // 29.97 NDF (1001/30000s/frame). A 5/4s = 1.25s clip is
      // (5/4) / (1001/30000) = (5 × 30000) / (4 × 1001) ≈ 37.46 frames,
      // NOT whole. Validator should surface a warning with the path.
      const text = `<?xml version="1.0"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.13">
  <resources>
    <format id="r1" frameDuration="1001/30000s" width="1920" height="1080"/>
    <asset id="r2"><media-rep src="file:///x.mov"/></asset>
  </resources>
  <library>
    <event name="e">
      <project name="p">
        <sequence format="r1" duration="5/4s">
          <spine>
            <asset-clip name="A" ref="r2" offset="0s" duration="5/4s"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`
      const result = validateFcpxml({ path: 'x.fcpxml', text })
      const frameIssues = result.issues.filter((i) => i.code === 'frame-boundary')
      expect(frameIssues.length).toBeGreaterThan(0)
      expect(frameIssues.some((i) => /duration="5\/4s"/.test(i.message))).toBe(true)
    })

    it('does not flag whole-frame values at the sequence rate', () => {
      // 24fps (1/24s/frame). 1s = 24 frames exactly.
      const text = `<?xml version="1.0"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.13">
  <resources>
    <format id="r1" frameDuration="1/24s" width="1920" height="1080"/>
    <asset id="r2"><media-rep src="file:///x.mov"/></asset>
  </resources>
  <library>
    <event name="e">
      <project name="p">
        <sequence format="r1" duration="1s">
          <spine>
            <asset-clip name="A" ref="r2" offset="0s" duration="1s"/>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`
      const result = validateFcpxml({ path: 'x.fcpxml', text })
      const frameIssues = result.issues.filter((i) => i.code === 'frame-boundary')
      expect(frameIssues).toEqual([])
    })

    it('skips frame-boundary check when sequence has no format ref', () => {
      const text = `<?xml version="1.0"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.13">
  <library><event name="e"><project name="p">
    <sequence duration="1s"><spine/></sequence>
  </project></event></library>
</fcpxml>`
      const result = validateFcpxml({ path: 'x.fcpxml', text })
      expect(result.issues.filter((i) => i.code === 'frame-boundary')).toEqual([])
    })
  })

  // Phase K8.1 — writer fidelity hotfixes from the Codex probe.
  describe('K8.1 writer hotfixes', () => {
    it('honours hasVideo / hasAudio from the IR for audio-only assets', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/30s' }],
            assets: [
              {
                id: 'r2',
                name: 'Audio only',
                src: 'file:///x.wav',
                hasVideo: '0',
                hasAudio: '1'
              }
            ]
          }
        }
      })
      // Asset emits hasVideo="0" hasAudio="1" — not the K7 default of 1/1.
      expect(writer.text).toMatch(/<asset[^>]+hasVideo="0"[^>]+hasAudio="1"/)
    })

    it('accepts boolean hasVideo / hasAudio as well as string', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            assets: [{ id: 'r1', src: 'file:///a.wav', hasVideo: false, hasAudio: true }]
          }
        }
      })
      expect(writer.text).toMatch(/<asset[^>]+hasVideo="0"[^>]+hasAudio="1"/)
    })

    it('defaults hasVideo / hasAudio to "1" when the IR omits them (K7 back-compat)', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            assets: [{ id: 'r1', src: 'file:///a.mov' }]
          }
        }
      })
      // Both default on, matching pre-K8.1 emission.
      expect(writer.text).toMatch(/<asset[^>]+hasVideo="1"[^>]+hasAudio="1"/)
    })

    it('emits audioRole/videoRole on asset-clip when the IR supplies them explicitly', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }],
            assets: [{ id: 'r2', src: 'file:///x.mp4' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                duration: '1s',
                spine: [
                  {
                    index: 0,
                    type: 'asset-clip',
                    name: 'clip',
                    ref: 'r2',
                    offset: '0s',
                    duration: '1s',
                    audioRole: 'dialogue',
                    videoRole: 'video',
                    markers: [],
                    captions: []
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toContain('audioRole="dialogue"')
      expect(writer.text).toContain('videoRole="video"')
      // Critically — no generic role attribute (DTD-illegal on asset-clip).
      expect(writer.text).not.toMatch(/<asset-clip[^>]+ role="/)
    })

    it('infers audioRole / videoRole from a generic role token on asset-clip', () => {
      // Agent uses the common shorthand `role: 'dialogue'` — writer
      // splits to audioRole. Same for music / effects. Non-audio
      // tokens fall through to videoRole.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }],
            assets: [{ id: 'r2', src: 'file:///x.mp4' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'asset-clip',
                    name: 'a',
                    ref: 'r2',
                    duration: '1s',
                    role: 'music',
                    markers: [],
                    captions: []
                  },
                  {
                    index: 1,
                    type: 'asset-clip',
                    name: 'b',
                    ref: 'r2',
                    duration: '1s',
                    role: 'video',
                    markers: [],
                    captions: []
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toMatch(/asset-clip[^>]+audioRole="music"/)
      expect(writer.text).toMatch(/asset-clip[^>]+videoRole="video"/)
      // No generic role attribute anywhere on asset-clip elements.
      expect(writer.text).not.toMatch(/<asset-clip[^>]+ role="/)
    })

    it('keeps the generic role attribute on non-asset-clip items', () => {
      // Gap, clip, title items still use `role` per the DTD —
      // audioRole/videoRole is asset-clip-specific.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'gap',
                    duration: '1s',
                    role: 'silence',
                    markers: [],
                    captions: []
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toMatch(/<gap[^>]+role="silence"/)
      expect(writer.text).not.toMatch(/audioRole|videoRole/)
    })

    it('coerces flat title fields into the canonical textRuns/styleDefs/params shape', () => {
      // The Codex 2.1 / 3.1 misses: agent passes flat `text`/`font`/
      // `fontSize` keys, writer (pre-K8.1) emitted a bare title.
      // Now the writer promotes the flat shape on entry.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }],
            effects: [{ id: 'r3', name: 'Basic Title' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'Hello',
                    ref: 'r3',
                    offset: '0s',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    text: 'Hello world',
                    font: 'Helvetica',
                    fontSize: '72',
                    alignment: 'center',
                    position: '0 -200'
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toContain('<text>')
      expect(writer.text).toContain('Hello world')
      expect(writer.text).toContain('<text-style-def')
      expect(writer.text).toContain('font="Helvetica"')
      expect(writer.text).toContain('fontSize="72"')
      // K11 — Position now emits with the canonical Apple-internal
      // key alongside the value, not the bare K8.1 form. The other
      // three required Basic Title params (Flatten, Alignment,
      // disableDRT) also injected automatically.
      expect(writer.text).toContain(
        '<param name="Position" key="9999/999166631/999166633/1/100/101" value="0 -200"/>'
      )
    })

    it('does not overwrite explicit canonical title fields when flat fields are also present', () => {
      // If the agent supplies both shapes, the canonical wins. The
      // flat coercion is a "fill in the gaps" not a "override".
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: { formats: [{ id: 'r1', frameDuration: '1/24s' }] },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'mix',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    text: 'flat-text',
                    textRuns: [{ text: 'canonical-text', styleRef: 'ts1' }]
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toContain('canonical-text')
      expect(writer.text).not.toContain('flat-text')
    })

    // K11 — Canonical Basic Title params injection.
    it('K11: auto-injects the four canonical Basic Title params when a title has text content', () => {
      // The Codex probe 2.1 / 3.1 misses were exactly this: text was
      // emitted but the four required params weren't, so FCP created
      // a title element that bound to nothing. After K11 the writer
      // synthesises Position/Flatten/Alignment/disableDRT with the
      // Apple-internal keys harvested from a real FCP export.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }],
            effects: [
              {
                id: 'r3',
                name: 'Basic Title',
                uid: '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti'
              }
            ]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'Hello',
                    ref: 'r3',
                    offset: '0s',
                    duration: '1s',
                    lane: '1',
                    markers: [],
                    captions: [],
                    text: 'Hello world',
                    font: 'Helvetica',
                    fontSize: '72',
                    alignment: 'center'
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      // All four required params present with the canonical Apple
      // keys. Each key is the dotted-decimal Motion template
      // identifier — these are the exact strings FCP looks up.
      expect(writer.text).toContain(
        '<param name="Position" key="9999/999166631/999166633/1/100/101" value="0 0"/>'
      )
      expect(writer.text).toContain(
        '<param name="Flatten" key="9999/999166631/999166633/2/351" value="1"/>'
      )
      expect(writer.text).toContain(
        '<param name="Alignment" key="9999/999166631/999166633/2/354/999169573/401" value="1 (Center)"/>'
      )
      expect(writer.text).toContain('<param name="disableDRT" key="3733" value="1"/>')
    })

    it('K11: maps flat alignment token to the param value', () => {
      const makeTitle = (alignment: string) =>
        serializeFcpxmlTimelineIr({
          ir: {
            projects: [
              {
                name: 'p',
                sequence: {
                  spine: [
                    {
                      index: 0,
                      type: 'title',
                      name: 't',
                      duration: '1s',
                      markers: [],
                      captions: [],
                      text: 'x',
                      font: 'Helvetica',
                      alignment
                    }
                  ],
                  markers: []
                }
              }
            ]
          }
        }).text

      expect(makeTitle('left')).toContain('value="0 (Left)"')
      expect(makeTitle('center')).toContain('value="1 (Center)"')
      expect(makeTitle('right')).toContain('value="2 (Right)"')
      // Unknown → center default.
      expect(makeTitle('weird')).toContain('value="1 (Center)"')
    })

    it('K11: respects an agent-supplied position over the default centre', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          projects: [
            {
              name: 'p',
              sequence: {
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 't',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    text: 'lower third',
                    font: 'Helvetica',
                    position: '0 -400'
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toContain(
        '<param name="Position" key="9999/999166631/999166633/1/100/101" value="0 -400"/>'
      )
    })

    it('K11: fills fontFace="Regular" and fontColor="1 1 1 1" defaults on text-style-defs', () => {
      // FCP refuses to render titles whose text-style lacks an
      // explicit color. The agent rarely thinks to set it; K11 fills
      // the default white on emission.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          projects: [
            {
              name: 'p',
              sequence: {
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 't',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    text: 'x',
                    font: 'Helvetica',
                    fontSize: '72'
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toContain('fontFace="Regular"')
      expect(writer.text).toContain('fontColor="1 1 1 1"')
    })

    it('K11: respects an agent-supplied fontColor over the default white', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          projects: [
            {
              name: 'p',
              sequence: {
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 't',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    text: 'red text',
                    font: 'Helvetica',
                    fontColor: '1 0 0 1'
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).toContain('fontColor="1 0 0 1"')
      expect(writer.text).not.toContain('fontColor="1 1 1 1"')
    })

    it('K11: leaves agent-supplied titleParams alone (advanced templates pass through)', () => {
      // If the agent has done their homework and built a full custom
      // Motion template param set, don't second-guess them. K11's
      // injection only kicks in when titleParams is empty.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          projects: [
            {
              name: 'p',
              sequence: {
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'custom',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    textRuns: [{ text: 'expert title', styleRef: 'ts1' }],
                    textStyleDefs: [{ id: 'ts1', font: 'Custom', fontSize: '24' }],
                    titleParams: [
                      { name: 'CustomParam', key: 'expert/key/path', value: 'expert-value' }
                    ]
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      // Their custom param is emitted; the K11 defaults are NOT
      // injected because they declared their own.
      expect(writer.text).toContain('<param name="CustomParam" key="expert/key/path"')
      expect(writer.text).not.toContain('Position" key="9999/')
      expect(writer.text).not.toContain('Flatten" key="9999/')
    })

    it('K11: bare title element (no text content) passes through unmodified', () => {
      // The rare advanced case: agent emits an empty <title/> that
      // references a custom Motion template via uid. Don't inject
      // Basic Title params — they don't apply.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          projects: [
            {
              name: 'p',
              sequence: {
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'bare',
                    duration: '1s',
                    markers: [],
                    captions: []
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).not.toContain('Position" key="9999/')
      // Self-closing <title/> (or open+close pair) is fine; just no params.
      expect(writer.text).toMatch(/<title[^>]+name="bare"[^>]*\/?>/)
    })

    it('leaves non-title items untouched even when flat title fields are accidentally present', () => {
      // Defensive: an agent who copies a title IR into an asset-clip
      // shouldn't accidentally surface text/font on the clip.
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', frameDuration: '1/24s' }],
            assets: [{ id: 'r2', src: 'file:///x.mov' }]
          },
          projects: [
            {
              name: 'p',
              sequence: {
                format: 'r1',
                spine: [
                  {
                    index: 0,
                    type: 'asset-clip',
                    ref: 'r2',
                    duration: '1s',
                    markers: [],
                    captions: [],
                    text: 'should not appear',
                    font: 'Arial'
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })
      expect(writer.text).not.toContain('should not appear')
      expect(writer.text).not.toContain('font="Arial"')
    })
  })

  describe('FCPXML capability probe writer rows', () => {
    it('row 2.2: emits an audio-only asset-clip on lane -1 under the picture', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          resources: {
            formats: [{ id: 'r1', name: '24p', frameDuration: '1/24s' }],
            assets: [
              { id: 'r2', name: 'Picture', src: 'file:///picture.mov' },
              {
                id: 'r3',
                name: 'Music Bed',
                src: 'file:///music.wav',
                hasVideo: '0',
                hasAudio: '1'
              }
            ]
          },
          projects: [
            {
              name: 'probe-2-2',
              sequence: {
                format: 'r1',
                duration: '5s',
                spine: [
                  {
                    index: 0,
                    type: 'asset-clip',
                    name: 'Picture',
                    ref: 'r2',
                    offset: '0s',
                    duration: '5s',
                    videoRole: 'video',
                    markers: [],
                    captions: []
                  },
                  {
                    index: 1,
                    type: 'asset-clip',
                    name: 'Music Bed',
                    ref: 'r3',
                    offset: '0s',
                    duration: '5s',
                    lane: '-1',
                    audioRole: 'music',
                    markers: [],
                    captions: []
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })

      expect(writer.text).toMatch(/<asset[^>]+id="r3"[^>]+hasVideo="0"[^>]+hasAudio="1"/)
      expect(writer.text).toMatch(
        /<asset-clip[^>]+name="Music Bed"[^>]+lane="-1"[^>]+audioRole="music"/
      )
    })

    it('row 3.3: emits the canonical Basic Title Position param for offset titles', () => {
      const writer = serializeFcpxmlTimelineIr({
        ir: {
          projects: [
            {
              name: 'probe-3-3',
              sequence: {
                duration: '5s',
                spine: [
                  {
                    index: 0,
                    type: 'title',
                    name: 'Offset Title',
                    duration: '3s',
                    lane: '1',
                    markers: [],
                    captions: [],
                    text: 'Lower third',
                    position: '0 -200'
                  }
                ],
                markers: []
              }
            }
          ]
        }
      })

      expect(writer.text).toContain(
        '<param name="Position" key="9999/999166631/999166633/1/100/101" value="0 -200"/>'
      )
    })
  })
})
