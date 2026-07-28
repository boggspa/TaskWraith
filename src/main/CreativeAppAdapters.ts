export type CreativeAppId = 'final-cut-pro' | 'logic-pro' | 'blender'

export type CreativeAppTransport =
  | 'exchange-file'
  | 'workflow-extension'
  | 'apple-events'
  | 'drag-drop'
  | 'ax-ui'
  | 'screen-capture'
  | 'cli'
  | 'native-script'
  | 'live-addon'
  | 'core-midi'
  | 'control-surface'

export type CreativeRiskTier =
  | 'observe'
  | 'draft'
  | 'apply-to-copy'
  | 'live-control'
  | 'destructive-expensive'

export interface CreativeAttachedWindowMeta {
  title?: string
  bundleID?: string
  applicationName?: string
}

export interface CreativeCapability {
  id: string
  label: string
  riskTier: CreativeRiskTier
  transports: CreativeAppTransport[]
  readOnly: boolean
  requiresApproval: boolean
  summary: string
}

export interface CreativeAppDefinition {
  id: CreativeAppId
  label: string
  bundleIds: string[]
  commonAppPaths: string[]
  projectExtensions: string[]
  transports: CreativeAppTransport[]
  capabilities: CreativeCapability[]
  prompts: string[]
  limitations: string[]
}

export interface CreativeAppStatus {
  id: CreativeAppId
  label: string
  bundleIds: string[]
  installedHint: boolean
  /**
   * True when at least one of the app's declared `bundleIds` is currently
   * running according to `NSRunningApplication`. Surfaced separately from
   * `installedHint` because the agent often needs both signals: an app
   * can be installed-but-quit (don't suggest sending it work yet) or
   * running-but-not-focused (probably fine to push an import to).
   *
   * `false` when the daemon isn't available — callers should treat
   * `installedHint=true && runningHint=false` as "installed; running
   * status unknown or quit" since the probe degrades gracefully.
   * Phase K1.
   */
  runningHint: boolean
  attached: boolean
  attachedWindow?: CreativeAttachedWindowMeta
  projectExtensions: string[]
  transports: CreativeAppTransport[]
  capabilityCount: number
  riskTiers: CreativeRiskTier[]
  limitations: string[]
}

export interface CreativeAppStatusSnapshot {
  ok: true
  generatedAt: string
  appId?: CreativeAppId
  apps: CreativeAppStatus[]
}

export interface CreativeAppCapabilitySnapshot {
  ok: true
  generatedAt: string
  appId?: CreativeAppId
  apps: Array<
    CreativeAppStatus & {
      capabilities: CreativeCapability[]
      prompts: string[]
    }
  >
}

export type CreativeProjectKind =
  | 'fcpxml'
  | 'final-cut-library'
  | 'final-cut-xml-bundle'
  | 'logic-package'
  | 'musicxml'
  | 'midi'
  | 'blender-binary'
  | 'blender-exchange'
  | 'unknown'

export interface CreativeProjectSnapshotInput {
  path: string
  extension?: string
  isDirectory: boolean
  sizeBytes?: number
  text?: string
  bytes?: Uint8Array
  now?: string
}

export interface CreativeProjectSnapshot {
  ok: true
  generatedAt: string
  path: string
  appId?: CreativeAppId
  kind: CreativeProjectKind
  readOnly: true
  transport: CreativeAppTransport
  summary: string
  sizeBytes?: number
  stats: Record<string, number | string | boolean>
  warnings: string[]
}

export type CreativeValidationSeverity = 'error' | 'warning' | 'info'

export interface CreativeValidationIssue {
  severity: CreativeValidationSeverity
  code: string
  message: string
  detail?: string
}

export interface FcpxmlValidationInput {
  path: string
  text: string
  truncated?: boolean
  now?: string
}

export interface FcpxmlValidationResult {
  ok: true
  generatedAt: string
  appId: 'final-cut-pro'
  path: string
  kind: 'fcpxml'
  readOnly: true
  validation: 'lightweight-fcpxml'
  valid: boolean
  version: string
  stats: Record<string, number | string | boolean>
  issueCounts: Record<CreativeValidationSeverity, number>
  issues: CreativeValidationIssue[]
}

export interface FcpxmlTimelineIrInput {
  path: string
  text: string
  truncated?: boolean
  now?: string
}

export interface FcpxmlResourceIr {
  id: string
  name?: string
  uid?: string
  src?: string
  duration?: string
  start?: string
  format?: string
  role?: string
  mediaRepCount?: number
  /**
   * K8.1 — explicit hasVideo / hasAudio track-presence declarations.
   * Accepts boolean or '0'/'1' string. When undefined, the writer
   * defaults BOTH to "1" (back-compat with K7 emission) so existing
   * IRs that don't specify still work. Set hasVideo: false / '0' for
   * audio-only assets so FCP slots them onto audio lanes correctly.
   */
  hasVideo?: string | boolean
  hasAudio?: string | boolean
}

export interface FcpxmlFormatIr {
  id: string
  name?: string
  width?: string
  height?: string
  frameDuration?: string
  colorSpace?: string
}

export interface FcpxmlEffectIr {
  id: string
  name?: string
  uid?: string
}

export interface FcpxmlTimelineMarkerIr {
  type: 'marker' | 'chapter-marker' | 'caption'
  value?: string
  start?: string
  duration?: string
  note?: string
  role?: string
}

/**
 * Phase K8 — Title-specific rich content.
 *
 * A `<title>` timeline item in FCPXML carries text content as nested
 * children rather than attributes:
 *
 *   <title ...>
 *     <text>
 *       <text-style ref="ts1">Hello there</text-style>
 *     </text>
 *     <text-style-def id="ts1">
 *       <text-style font="Helvetica" fontSize="72" alignment="center"/>
 *     </text-style-def>
 *     <param name="Position" key="..." value="0 0"/>
 *   </title>
 *
 * Pre-K8 the IR collapsed `<title>` into a bare spine item, dropping all
 * of the above. Now we capture text runs + style defs + a small param
 * set; writer emits them; parser reads them back. Round-trip-safe.
 */
export interface FcpxmlTextRun {
  /** The literal text content (no XML escaping; writer handles that). */
  text: string
  /** Optional reference to a `<text-style-def>` by id. */
  styleRef?: string
}

export interface FcpxmlTextStyleDef {
  id: string
  font?: string
  fontSize?: string
  fontFace?: string
  fontColor?: string
  alignment?: string
}

export interface FcpxmlTitleParam {
  name: string
  /** FCPXML param `key` (the long dotted identifier path). Optional —
   * if omitted, FCP uses the default for the title preset. */
  key?: string
  value: string
}

export interface FcpxmlTimelineItemIr {
  index: number
  type: string
  name?: string
  ref?: string
  refName?: string
  offset?: string
  start?: string
  duration?: string
  lane?: string
  role?: string
  format?: string
  markers: FcpxmlTimelineMarkerIr[]
  captions: FcpxmlTimelineMarkerIr[]
  /**
   * Phase K8 — populated only when `type === 'title'`. Text runs are
   * emitted inside a `<text>` element; style defs as siblings; params
   * as direct children of the title element.
   */
  textRuns?: FcpxmlTextRun[]
  textStyleDefs?: FcpxmlTextStyleDef[]
  titleParams?: FcpxmlTitleParam[]
  /**
   * K8.1 — asset-clip-specific role split. The FCPXML DTD declares
   * `audioRole` and `videoRole` as the valid role attrs on
   * `<asset-clip>` — the generic `role` attribute is REJECTED by the
   * DTD on this element type. When emitting an asset-clip, the writer
   * uses these fields when supplied; falls back to inferring from
   * `role` when only the generic field is set. For non-asset-clip
   * items (clip, gap, title, etc.) the generic `role` attr is used.
   */
  audioRole?: string
  videoRole?: string
  /**
   * K8.1 — forgiving-input shape for title items. Agents commonly
   * supply title content as flat keys (text, font, fontSize, etc.)
   * rather than the canonical textRuns/textStyleDefs/titleParams
   * nested arrays. When these flat fields are present on a title
   * item, the writer auto-promotes them to the canonical shape
   * before emission. Use either shape — both work.
   */
  text?: string
  font?: string
  fontSize?: string
  fontFace?: string
  fontColor?: string
  alignment?: string
  position?: string
}

export interface FcpxmlSequenceIr {
  name?: string
  duration?: string
  format?: string
  tcStart?: string
  tcFormat?: string
  spine: FcpxmlTimelineItemIr[]
  markers: FcpxmlTimelineMarkerIr[]
}

export interface FcpxmlProjectIr {
  name?: string
  eventName?: string
  sequence?: FcpxmlSequenceIr
}

export interface FcpxmlTimelineIr {
  ok: true
  generatedAt: string
  appId: 'final-cut-pro'
  path: string
  kind: 'fcpxml'
  readOnly: true
  ir: 'fcpxml-timeline-ir-v1'
  version: string
  resources: {
    assets: FcpxmlResourceIr[]
    formats: FcpxmlFormatIr[]
    effects: FcpxmlEffectIr[]
  }
  projects: FcpxmlProjectIr[]
  summary: Record<string, number | string | boolean>
  warnings: string[]
}

export interface FcpxmlTimelineDiffInput {
  beforePath: string
  beforeText: string
  afterPath: string
  afterText: string
  beforeTruncated?: boolean
  afterTruncated?: boolean
  now?: string
}

export interface FcpxmlTimelineDiffItemSummary {
  index: number
  type: string
  name?: string
  ref?: string
  refName?: string
  offset?: string
  start?: string
  duration?: string
  lane?: string
  role?: string
  format?: string
  markerCount: number
  captionCount: number
}

export interface FcpxmlTimelineChangedItemIr {
  index: number
  fields: string[]
  before: FcpxmlTimelineDiffItemSummary
  after: FcpxmlTimelineDiffItemSummary
}

export interface FcpxmlTimelineProjectDiffIr {
  index: number
  fields: string[]
  beforeName?: string
  afterName?: string
  eventName?: string
  addedItems: FcpxmlTimelineDiffItemSummary[]
  removedItems: FcpxmlTimelineDiffItemSummary[]
  changedItems: FcpxmlTimelineChangedItemIr[]
}

export interface FcpxmlTimelineAffectedResourceIr {
  id: string
  name?: string
  uid?: string
}

export interface FcpxmlTimelineDiffPlan {
  ok: true
  generatedAt: string
  appId: 'final-cut-pro'
  kind: 'fcpxml'
  readOnly: true
  diff: 'fcpxml-timeline-diff-v1'
  beforePath: string
  afterPath: string
  summary: Record<string, number | string | boolean>
  affectedResources: {
    assets: FcpxmlTimelineAffectedResourceIr[]
    effects: FcpxmlTimelineAffectedResourceIr[]
  }
  projects: FcpxmlTimelineProjectDiffIr[]
  sidecar: {
    schema: 'taskwraith-fcpxml-diff-plan-v1'
    recommendedPath: string
    document: Record<string, unknown>
  }
  warnings: string[]
}

export interface CreativeAppProbeInput {
  appId?: CreativeAppId
  attachedWindow?: CreativeAttachedWindowMeta | null
  now?: string
  fileExists?: (path: string) => boolean
  /**
   * Predicate that answers "is this bundle id currently running?" for a
   * given bundle id. Backed by the Swift daemon's
   * `creative.runningApplications` JSON-RPC method via
   * `NSRunningApplication.runningApplications(withBundleIdentifier:)`.
   * Omit when the probe is unavailable (no daemon) — `runningHint`
   * degrades to `false`. Phase K1.
   */
  runningHint?: (bundleId: string) => boolean
}

const CREATIVE_APP_DEFINITIONS: CreativeAppDefinition[] = [
  {
    id: 'final-cut-pro',
    label: 'Final Cut Pro',
    bundleIds: ['com.apple.FinalCut'],
    commonAppPaths: ['/Applications/Final Cut Pro.app'],
    projectExtensions: ['.fcpxml', '.fcpxmld', '.fcpbundle'],
    transports: [
      'exchange-file',
      'workflow-extension',
      'apple-events',
      'drag-drop',
      'ax-ui',
      'screen-capture'
    ],
    capabilities: [
      {
        id: 'fcpxml-timeline-snapshot',
        label: 'FCPXML timeline snapshot',
        riskTier: 'observe',
        transports: ['exchange-file'],
        readOnly: true,
        requiresApproval: false,
        summary: 'Parse exported FCPXML for clips, edit decisions, metadata, markers, and assets.'
      },
      {
        id: 'fcpxml-timeline-ir',
        label: 'FCPXML timeline IR',
        riskTier: 'observe',
        transports: ['exchange-file'],
        readOnly: true,
        requiresApproval: false,
        summary: 'Parse FCPXML into a compact timeline IR for diffing, draft plans, and preview UX.'
      },
      {
        id: 'fcpxml-diff-plan',
        label: 'FCPXML diff plan',
        riskTier: 'observe',
        transports: ['exchange-file'],
        readOnly: true,
        requiresApproval: false,
        summary:
          'Compare original and drafted FCPXML files into an approval-ready diff plan and JSON sidecar payload.'
      },
      {
        id: 'fcpxml-lightweight-validate',
        label: 'FCPXML lightweight validation',
        riskTier: 'draft',
        transports: ['exchange-file'],
        readOnly: true,
        requiresApproval: false,
        summary:
          'Check FCPXML root/version, duplicate ids, unresolved refs, and structural counts before import planning.'
      },
      {
        id: 'fcpxml-patch-plan',
        label: 'FCPXML patch plan',
        riskTier: 'draft',
        transports: ['exchange-file'],
        readOnly: false,
        requiresApproval: false,
        summary: 'Generate a proposed FCPXML patch or import bundle without touching Final Cut Pro.'
      },
      {
        id: 'fcpxml-approved-import',
        label: 'Approved FCPXML import',
        riskTier: 'live-control',
        transports: ['apple-events', 'drag-drop'],
        readOnly: false,
        requiresApproval: true,
        summary: 'Send a validated FCPXML document to Final Cut Pro only after user approval.'
      },
      {
        id: 'fcp-window-observe',
        label: 'Attached window observation',
        riskTier: 'observe',
        transports: ['screen-capture'],
        readOnly: true,
        requiresApproval: true,
        summary: 'Use the user-attached Final Cut Pro window for visual confirmation and OCR.'
      }
    ],
    prompts: ['shot_list_to_fcpxml', 'caption_timeline_from_srt', 'paper_edit_from_transcript'],
    limitations: [
      'No broad public live timeline mutation API is assumed.',
      'FCPXML import should target a scratch library or copy by default.',
      'Workflow extensions provide limited timeline/playhead awareness, not full headless editing.'
    ]
  },
  {
    id: 'logic-pro',
    label: 'Logic Pro',
    bundleIds: ['com.apple.logic10'],
    commonAppPaths: ['/Applications/Logic Pro.app'],
    projectExtensions: ['.logicx', '.mid', '.midi', '.musicxml', '.xml', '.aaf'],
    transports: [
      'exchange-file',
      'core-midi',
      'control-surface',
      'native-script',
      'ax-ui',
      'screen-capture'
    ],
    capabilities: [
      {
        id: 'logic-file-bridge',
        label: 'MIDI/MusicXML/audio file bridge',
        riskTier: 'draft',
        transports: ['exchange-file'],
        readOnly: false,
        requiresApproval: false,
        summary: 'Generate or parse MIDI, MusicXML, AAF/FCPXML, and stem bundles in the workspace.'
      },
      {
        id: 'logic-scripter-author',
        label: 'Scripter MIDI FX authoring',
        riskTier: 'draft',
        transports: ['native-script'],
        readOnly: false,
        requiresApproval: false,
        summary: 'Generate paste-ready Logic Scripter JavaScript with deterministic MIDI behavior.'
      },
      {
        id: 'logic-midi-audition',
        label: 'Virtual MIDI audition',
        riskTier: 'live-control',
        transports: ['core-midi'],
        readOnly: false,
        requiresApproval: true,
        summary: 'Send bounded MIDI notes or controller data to Logic Virtual In for auditioning.'
      },
      {
        id: 'logic-approved-ui-action',
        label: 'Approved Logic UI action',
        riskTier: 'live-control',
        transports: ['ax-ui', 'control-surface'],
        readOnly: false,
        requiresApproval: true,
        summary:
          'Use menu/control-surface actions only for approved import, export, transport, or bounce flows.'
      }
    ],
    prompts: ['soundtrack_spotting_notes', 'mix_notes_to_logic_regions'],
    limitations: [
      'Direct .logicx package mutation is not treated as a public API.',
      'Control-surface and Accessibility paths are fallback transports.',
      'Real-time Scripter or Audio Unit callbacks should stay deterministic and offline.'
    ]
  },
  {
    id: 'blender',
    label: 'Blender',
    bundleIds: ['org.blenderfoundation.blender'],
    commonAppPaths: ['/Applications/Blender.app'],
    projectExtensions: ['.blend', '.blend1', '.fbx', '.obj', '.gltf', '.glb'],
    transports: ['cli', 'native-script', 'live-addon', 'screen-capture'],
    capabilities: [
      {
        id: 'blender-scene-query',
        label: 'Scene graph query',
        riskTier: 'observe',
        transports: ['native-script', 'cli'],
        readOnly: true,
        requiresApproval: false,
        summary:
          'Inspect objects, materials, nodes, collections, and render settings through Blender data APIs.'
      },
      {
        id: 'blender-structured-scene-patch',
        label: 'Structured scene patch',
        riskTier: 'apply-to-copy',
        transports: ['native-script', 'cli', 'live-addon'],
        readOnly: false,
        requiresApproval: true,
        summary: 'Apply structured scene changes to a copy or approved live bridge session.'
      },
      {
        id: 'blender-render-preview',
        label: 'Render preview',
        riskTier: 'apply-to-copy',
        transports: ['cli', 'native-script'],
        readOnly: false,
        requiresApproval: true,
        summary: 'Run bounded preview renders and return artifacts to TaskWraith.'
      },
      {
        id: 'blender-generated-python',
        label: 'Generated Python execution',
        riskTier: 'destructive-expensive',
        transports: ['native-script', 'cli', 'live-addon'],
        readOnly: false,
        requiresApproval: true,
        summary: 'Execute generated Blender Python only after code preview and explicit approval.'
      }
    ],
    prompts: ['blender_scene_optimize', 'render_preview_and_review'],
    limitations: [
      'Blender Python is not sandboxed.',
      'Batch jobs should default to --disable-autoexec, --offline-mode, and workspace artifacts.',
      'Live bridge commands should be structured and token-authenticated.'
    ]
  }
]

const CREATIVE_APP_IDS = new Set(CREATIVE_APP_DEFINITIONS.map((definition) => definition.id))

export function isCreativeAppId(value: unknown): value is CreativeAppId {
  return typeof value === 'string' && CREATIVE_APP_IDS.has(value as CreativeAppId)
}

export function listCreativeAppDefinitions(): CreativeAppDefinition[] {
  return CREATIVE_APP_DEFINITIONS.map((definition) => cloneDefinition(definition))
}

/**
 * Flat de-duplicated list of every bundle id any creative-app definition
 * declares. Handy for the main-process running-app probe: it can fetch
 * the running-state of all bundle ids in a single JSON-RPC call to the
 * daemon, then hand the resulting map back through the `runningHint`
 * predicate. Phase K1.
 */
export function listCreativeAppBundleIds(): string[] {
  const set = new Set<string>()
  for (const definition of CREATIVE_APP_DEFINITIONS) {
    for (const bundleId of definition.bundleIds) set.add(bundleId)
  }
  return [...set]
}

export function buildCreativeAppStatusSnapshot(
  input: CreativeAppProbeInput = {}
): CreativeAppStatusSnapshot {
  const generatedAt = input.now || new Date().toISOString()
  return {
    ok: true,
    generatedAt,
    appId: input.appId,
    apps: matchingDefinitions(input.appId).map((definition) =>
      statusForDefinition(definition, input)
    )
  }
}

export function buildCreativeAppCapabilitySnapshot(
  input: CreativeAppProbeInput = {}
): CreativeAppCapabilitySnapshot {
  const generatedAt = input.now || new Date().toISOString()
  return {
    ok: true,
    generatedAt,
    appId: input.appId,
    apps: matchingDefinitions(input.appId).map((definition) => ({
      ...statusForDefinition(definition, input),
      capabilities: definition.capabilities.map((capability) => ({ ...capability })),
      prompts: [...definition.prompts]
    }))
  }
}

export function buildCreativeProjectSnapshot(
  input: CreativeProjectSnapshotInput
): CreativeProjectSnapshot {
  const generatedAt = input.now || new Date().toISOString()
  const extension = normalizeExtension(input.extension || extensionFromPath(input.path))
  const inferred = inferCreativeProjectKind(input, extension)
  const stats = buildProjectStats(inferred.kind, input)
  return {
    ok: true,
    generatedAt,
    path: input.path,
    appId: inferred.appId,
    kind: inferred.kind,
    readOnly: true,
    transport: inferred.transport,
    summary: inferred.summary,
    sizeBytes: input.sizeBytes,
    stats,
    warnings: buildProjectWarnings(inferred.kind, input)
  }
}

export function validateFcpxml(input: FcpxmlValidationInput): FcpxmlValidationResult {
  const generatedAt = input.now || new Date().toISOString()
  const text = input.text || ''
  const stats = buildProjectStats('fcpxml', { path: input.path, isDirectory: false, text })
  const issues: CreativeValidationIssue[] = []

  if (!text.trim()) {
    issues.push({
      severity: 'error',
      code: 'empty-document',
      message: 'FCPXML document is empty.'
    })
  }
  if (!textIncludes(text, '<fcpxml')) {
    issues.push({
      severity: 'error',
      code: 'missing-root',
      message: 'FCPXML document does not contain an <fcpxml> root element.'
    })
  }

  const version = typeof stats.version === 'string' ? stats.version : 'unknown'
  if (version === 'unknown') {
    issues.push({
      severity: 'warning',
      code: 'missing-version',
      message: 'FCPXML root has no detected version attribute.'
    })
  } else if (!/^\d+(\.\d+)?$/.test(version)) {
    issues.push({
      severity: 'warning',
      code: 'unexpected-version-format',
      message: `FCPXML version "${version}" does not look like a numeric version.`
    })
  }

  const ids = collectAttributeValues(text, 'id')
  const duplicateIds = duplicateValues(ids)
  for (const id of duplicateIds.slice(0, 20)) {
    issues.push({
      severity: 'error',
      code: 'duplicate-id',
      message: `Duplicate FCPXML id "${id}" detected.`
    })
  }
  if (duplicateIds.length > 20) {
    issues.push({
      severity: 'warning',
      code: 'duplicate-id-truncated',
      message: `${duplicateIds.length - 20} additional duplicate ids were omitted from this result.`
    })
  }

  const idSet = new Set(ids)
  const unresolvedRefs = collectAttributeValues(text, 'ref').filter((ref) => !idSet.has(ref))
  for (const ref of [...new Set(unresolvedRefs)].slice(0, 20)) {
    issues.push({
      severity: 'error',
      code: 'unresolved-ref',
      message: `Reference "${ref}" does not match any detected id.`
    })
  }
  if (unresolvedRefs.length > 20) {
    issues.push({
      severity: 'warning',
      code: 'unresolved-ref-truncated',
      message: `${unresolvedRefs.length - 20} additional unresolved refs were omitted from this result.`
    })
  }

  if (Number(stats.assets || 0) === 0) {
    issues.push({
      severity: 'info',
      code: 'no-assets',
      message: 'No <asset> entries were detected.'
    })
  }
  if (Number(stats.sequences || 0) === 0) {
    issues.push({
      severity: 'info',
      code: 'no-sequences',
      message: 'No <sequence> entries were detected.'
    })
  }
  if (input.truncated) {
    issues.push({
      severity: 'warning',
      code: 'document-truncated',
      message: 'Only the initial portion of this FCPXML document was validated.',
      detail: 'Increase the snapshot limit or validate the file externally before importing.'
    })
  }

  // Phase K8 — frame-boundary preflight. Walk each sequence, look up
  // its format's frameDuration, then for every spine item's
  // (offset|start|duration) check whether the value falls on a frame
  // boundary at the sequence's frame rate. Surfaces FCP's "not on an
  // edit frame boundary" warning at preflight time so agents can
  // self-correct before dispatch — same diagnostic, before the modal.
  try {
    const document = parseXmlDocument(text)
    const formatsByIdLocal = new Map<string, FcpxmlFormatIr>()
    for (const node of descendants(document, 'format')) {
      const ir = formatToIr(node)
      if (ir.id) formatsByIdLocal.set(ir.id, ir)
    }
    const allSequences = descendants(document, 'sequence')
    for (const sequenceNode of allSequences) {
      const formatRef = sequenceNode.attrs.format
      if (!formatRef) continue
      const format = formatsByIdLocal.get(formatRef)
      if (!format) continue
      const frameTime = parseFcpxmlTime(format.frameDuration)
      if (!frameTime) continue
      const checkAttr = (
        nodeName: string,
        attrName: string,
        attrValue: string | undefined,
        location: string
      ) => {
        if (!attrValue) return
        const parsed = parseFcpxmlTime(attrValue)
        if (!parsed) return
        // value (parsed.num / parsed.den) measured in frame units
        // (frameTime.num / frameTime.den) is:
        //   frames = (parsed.num / parsed.den) ÷ (frameTime.num / frameTime.den)
        //          = (parsed.num * frameTime.den) / (parsed.den * frameTime.num)
        // Whole-number frames ⇒ frame-aligned.
        const a = parsed.num * frameTime.den
        const b = parsed.den * frameTime.num
        if (b === 0) return
        if (a % b !== 0) {
          issues.push({
            severity: 'warning',
            code: 'frame-boundary',
            message: `${nodeName} ${attrName}="${attrValue}" is not on a frame boundary at ${format.frameDuration}/frame.`,
            detail: `Location: ${location}. Use a value that is an exact multiple of the sequence frame duration; the K8 writer auto-canonicalizes when the IR feeds time strings whose denominator divides the format's frame denominator.`
          })
        }
      }
      const spineNode = firstChild(sequenceNode, 'spine')
      const itemsToCheck = spineNode
        ? spineNode.children.filter((c) => isTimelineItemNode(c.name))
        : []
      itemsToCheck.forEach((item, idx) => {
        const loc = `sequence/spine/${item.name}[${idx + 1}]`
        checkAttr(item.name, 'offset', item.attrs.offset, loc)
        checkAttr(item.name, 'start', item.attrs.start, loc)
        checkAttr(item.name, 'duration', item.attrs.duration, loc)
      })
    }
  } catch (err) {
    // Frame-boundary check is best-effort. If parsing throws, leave
    // the issues set unmodified and let xmllint preflight (run at
    // import time) catch any structural problems.
    issues.push({
      severity: 'info',
      code: 'frame-boundary-skipped',
      message: 'Frame-boundary preflight skipped due to a parsing error.',
      detail: (err as Error).message
    })
  }

  return {
    ok: true,
    generatedAt,
    appId: 'final-cut-pro',
    path: input.path,
    kind: 'fcpxml',
    readOnly: true,
    validation: 'lightweight-fcpxml',
    valid: !issues.some((issue) => issue.severity === 'error'),
    version,
    stats,
    issueCounts: countIssuesBySeverity(issues),
    issues
  }
}

export function buildFcpxmlTimelineIr(input: FcpxmlTimelineIrInput): FcpxmlTimelineIr {
  const generatedAt = input.now || new Date().toISOString()
  const text = input.text || ''
  const stats = buildProjectStats('fcpxml', { path: input.path, isDirectory: false, text })
  const document = parseXmlDocument(text)
  const fcpxml = firstDescendant(document, 'fcpxml')
  const warnings: string[] = []
  if (!fcpxml) {
    warnings.push('No <fcpxml> root element was found; timeline IR may be empty.')
  }
  if (input.truncated) {
    warnings.push('Only the initial portion of this FCPXML document was parsed into timeline IR.')
  }

  const assets = descendants(document, 'asset').map(assetToIr)
  const assetNameById = new Map(
    assets.map((asset) => [asset.id, asset.name || asset.uid || asset.id])
  )
  const formats = descendants(document, 'format').map(formatToIr)
  const effects = descendants(document, 'effect').map(effectToIr)
  const effectNameById = new Map(
    effects.map((effect) => [effect.id, effect.name || effect.uid || effect.id])
  )

  const projects = descendants(document, 'project').map((project) => {
    const sequence = firstChild(project, 'sequence') || firstDescendant(project, 'sequence')
    return {
      name: project.attrs.name,
      eventName: nearestAncestorName(project, 'event'),
      sequence: sequence ? sequenceToIr(sequence, assetNameById, effectNameById) : undefined
    }
  })

  if (projects.length === 0) {
    warnings.push('No <project> entries were detected.')
  }

  const clipCount = projects.reduce(
    (count, project) => count + (project.sequence?.spine.length || 0),
    0
  )
  const markerCount = projects.reduce(
    (count, project) => count + (project.sequence?.markers.length || 0),
    0
  )

  return {
    ok: true,
    generatedAt,
    appId: 'final-cut-pro',
    path: input.path,
    kind: 'fcpxml',
    readOnly: true,
    ir: 'fcpxml-timeline-ir-v1',
    version: typeof stats.version === 'string' ? stats.version : 'unknown',
    resources: { assets, formats, effects },
    projects,
    summary: {
      projectCount: projects.length,
      sequenceCount: projects.filter((project) => project.sequence).length,
      assetCount: assets.length,
      formatCount: formats.length,
      effectCount: effects.length,
      timelineItemCount: clipCount,
      markerCount,
      truncated: Boolean(input.truncated)
    },
    warnings
  }
}

/**
 * K2 — Forward emitter: FCPXML timeline IR → FCPXML document text.
 *
 * Pairs with `buildFcpxmlTimelineIr`. Lets an agent build a timeline
 * structurally (assets, sequences, clips, markers) and emit a valid
 * `.fcpxml` that Final Cut Pro can ingest via the K3 import path or a
 * traditional File → Import XML flow.
 *
 * Fidelity envelope:
 * - LOSSLESS for everything the IR captures: resource ids/names, format
 *   geometry, asset src/role/duration, spine item shape (type, ref,
 *   offset/start/duration, lane/role/format/name), markers/captions
 *   with their start/duration/value/note/role.
 * - LOSSY for everything the IR drops on parse: arbitrary XML
 *   attributes outside the well-known set, `<media-rep>` storage
 *   metadata (we only count it in the IR, we don't round-trip it),
 *   custom param/key-frame data, comments, processing instructions.
 *
 * The writer is intended for new content the agent constructs, not for
 * mutating arbitrary user-authored .fcpxml — the IR isn't rich enough
 * for that and a "round-trip user FCPXML" capability would need a
 * separate, richer IR.
 */
export interface FcpxmlTimelineWriterInput {
  /**
   * The IR to emit. Accepts the full `FcpxmlTimelineIr` shape returned
   * by `buildFcpxmlTimelineIr` (the agent reads → mutates → re-emits
   * flow) OR an agent-constructed minimal subset (`version` defaults
   * to '1.13' when missing; `resources` defaults to empty arrays;
   * `projects` defaults to empty).
   */
  ir: {
    version?: string
    resources?: {
      assets?: FcpxmlResourceIr[]
      formats?: FcpxmlFormatIr[]
      effects?: FcpxmlEffectIr[]
    }
    projects?: FcpxmlProjectIr[]
  }
  /** Indent string per nesting level. Default '  ' (two spaces). */
  indent?: string
}

export interface FcpxmlTimelineWriterResult {
  ok: true
  text: string
  summary: {
    assetCount: number
    formatCount: number
    effectCount: number
    projectCount: number
    timelineItemCount: number
    markerCount: number
  }
  warnings: string[]
}

/**
 * Escape a string for safe inclusion as an XML attribute value or text
 * node. Mirrors the parser's tolerance — `'`, `"`, `<`, `>`, `&` all
 * get entitised. Newlines and other control chars are preserved so
 * the writer doesn't accidentally re-flow long marker notes.
 */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build an XML attribute string from a set of named values. Skips
 * `undefined` / empty-string attributes — FCPXML's parsers (including
 * our own) treat absent and empty attributes as identical, but FCP
 * itself is fussier and will complain about `name=""` on a clip. The
 * writer is conservative: only emit attributes the IR actually carries.
 */
/**
 * Phase K8 — Parse an FCPXML rational time string.
 *
 * Accepts:
 *   - "0s" / "5s"               → { num: 0|5, den: 1 }
 *   - "5/4s"                    → { num: 5, den: 4 }
 *   - "1001/30000s"             → { num: 1001, den: 30000 }
 *
 * Returns `null` for empty / unparseable input — caller should
 * passthrough the original string in that case rather than corrupt it.
 */
export function parseFcpxmlTime(value: string | undefined): { num: number; den: number } | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.endsWith('s')) return null
  const inner = trimmed.slice(0, -1)
  if (inner === '') return null
  if (inner.includes('/')) {
    const [n, d] = inner.split('/')
    const num = Number(n)
    const den = Number(d)
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
    return { num, den }
  }
  const num = Number(inner)
  if (!Number.isFinite(num)) return null
  return { num, den: 1 }
}

/**
 * Phase K8 — Canonicalize an FCPXML time string against a target
 * denominator (typically the sequence's format's `frameDuration`
 * denominator).
 *
 * FCP's importer doesn't simplify rationals before checking frame
 * alignment, so `5/4s` (which is mathematically `30/24s` at 24fps,
 * a whole 30 frames) trips the "not on an edit frame boundary"
 * warning. Scaling to a shared denominator across the entire spine
 * avoids the warning AND makes the doc match what FCP's own
 * exporter emits.
 *
 * Returns the original string when:
 *   - the value can't be parsed
 *   - the target denominator doesn't evenly divide the value's denominator
 *     (i.e. canonicalization would require fractional numerators —
 *     would not actually be on a frame boundary, so we leave the
 *     value as-is and let the frame-boundary check below flag it)
 */
export function canonicalizeFcpxmlTime(value: string | undefined, targetDen: number): string {
  if (value === undefined || value === '') return ''
  if (!Number.isFinite(targetDen) || targetDen <= 0) return value
  const parsed = parseFcpxmlTime(value)
  if (!parsed) return value
  // Scale numerator: newNum = num * (targetDen / den). Only valid
  // when targetDen is an integer multiple of den.
  if (parsed.den === targetDen) {
    return `${parsed.num}/${targetDen}s`
  }
  if (targetDen % parsed.den !== 0) {
    // Can't scale exactly — return original. The frame-boundary
    // checker will flag this as unaligned.
    return value
  }
  const factor = targetDen / parsed.den
  const newNum = parsed.num * factor
  if (!Number.isInteger(newNum)) return value
  // Preserve "0s" as compact form — FCP accepts both but humans
  // prefer the shorter version, and there's no ambiguity at zero.
  if (newNum === 0) return '0s'
  return `${newNum}/${targetDen}s`
}

/**
 * Phase K8 — Resolve the canonical denominator for a sequence by
 * reading its referenced `<format>` resource's `frameDuration`.
 *
 * Returns `null` when no usable frameDuration is available — caller
 * skips canonicalization in that case.
 */
export function getSequenceCanonicalDenominator(
  sequenceFormatRef: string | undefined,
  formats: FcpxmlFormatIr[]
): number | null {
  if (!sequenceFormatRef) return null
  const format = formats.find((f) => f.id === sequenceFormatRef)
  if (!format) return null
  const parsed = parseFcpxmlTime(format.frameDuration)
  if (!parsed) return null
  return parsed.den
}

/**
 * K8.1 — Normalise a hasVideo/hasAudio IR value (boolean OR string)
 * into the literal "0"/"1" the FCPXML attribute expects. Returns
 * the supplied default when the value is undefined so we stay
 * back-compat with K7 emission.
 */
function normaliseTrackFlag(value: string | boolean | undefined, defaultStr: '0' | '1'): '0' | '1' {
  if (value === undefined) return defaultStr
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value === 'true' || value === '1') return '1'
  if (value === 'false' || value === '0') return '0'
  // Unknown values fall back to the default rather than emit garbage.
  return defaultStr
}

/**
 * K8.1 — When an asset-clip carries only a generic `role` value (not
 * the DTD-correct audioRole/videoRole split), infer which side based
 * on common role tokens. FCP's built-in roles use these conventions:
 *   - audio side: dialogue, music, effects, audio, audio*
 *   - video side: video, titles, effects-video
 * Returns `{ audioRole, videoRole }` with at most one populated.
 * Unrecognised role values default to videoRole — matches FCP's
 * own default when only one role is declared on a video asset.
 */
function splitAssetClipRole(role: string | undefined): {
  audioRole?: string
  videoRole?: string
} {
  if (!role) return {}
  const lower = role.toLowerCase()
  const audioTokens = ['dialogue', 'music', 'effects', 'audio']
  if (audioTokens.some((t) => lower.includes(t)) && lower !== 'effects-video') {
    return { audioRole: role }
  }
  return { videoRole: role }
}

/**
 * K8.1 — Coerce a title spine item that uses flat field shorthand
 * (text/font/fontSize/alignment/position) into the canonical K8 nested
 * shape (textRuns / textStyleDefs / titleParams). Agents commonly
 * supply title content this way because it mirrors how titles are
 * conceptually described in plain English; the canonical shape
 * matches FCP's actual XML structure. Both work after this coercion.
 *
 * Returns the item unchanged if:
 *   - it's not a title
 *   - canonical fields are already populated (don't overwrite the
 *     agent's explicit shape)
 *   - no flat fields are present
 */
/**
 * K11 — Apple's canonical Basic Title parameters.
 *
 * Extracted from a real FCP-authored FCPXML export. The four params
 * below are what FCP's importer requires before it'll materialize a
 * `<title ref="(Basic Title effect)">` element into a visible title.
 * Pre-K11 emission carried the right effect UID + the right text /
 * style structure but omitted these params; FCP created the element
 * in the project but bound it to nothing, resulting in "title clip
 * exists in the timeline but renders nothing" — what the Codex probe
 * was hitting on rows 2.1 and 3.1.
 *
 * The `key` values are Apple-internal parameter identifiers
 * (dotted-decimal path through the Basic Title Motion template's
 * param tree). They are stable across FCP releases for the Basic
 * Title template specifically; if Apple ever rev's the template the
 * keys would change and we'd need a new template fingerprint here.
 */
const BASIC_TITLE_PARAMS = {
  position: {
    name: 'Position',
    key: '9999/999166631/999166633/1/100/101',
    defaultValue: '0 0' // centered
  },
  flatten: {
    name: 'Flatten',
    key: '9999/999166631/999166633/2/351',
    defaultValue: '1'
  },
  alignment: {
    name: 'Alignment',
    key: '9999/999166631/999166633/2/354/999169573/401',
    defaultValue: '1 (Center)' // Left = "0 (Left)", Right = "2 (Right)"
  },
  disableDRT: {
    name: 'disableDRT',
    key: '3733',
    defaultValue: '1'
  }
} as const

/**
 * Map a friendly alignment token (left/center/right) to FCP's
 * dotted-decimal Alignment param value. Unknown tokens default to
 * center because that's what 99% of titles use.
 */
function mapAlignmentToBasicTitleParam(alignment: string | undefined): string {
  switch ((alignment || '').toLowerCase()) {
    case 'left':
      return '0 (Left)'
    case 'right':
      return '2 (Right)'
    case 'center':
    case 'centered':
    default:
      return '1 (Center)'
  }
}

/**
 * K11 — Auto-inject canonical Basic Title params + style defaults
 * when a title item has text content but doesn't carry the four
 * required params. Lets agents author titles in the natural "text +
 * font + size + alignment + position" shape and still get a title
 * FCP actually renders.
 *
 * Strategy:
 *  - If the agent supplied any `titleParams`, respect them — they
 *    might be authoring an advanced Motion title we don't recognise.
 *  - Otherwise: synthesise the four canonical params. Position comes
 *    from `item.position` (flat shape) when supplied; Alignment from
 *    `item.alignment` when supplied; Flatten + disableDRT use the
 *    template defaults.
 *  - Also fill in `fontFace="Regular"` and `fontColor="1 1 1 1"` on
 *    text-style-defs that lack them — FCP refuses to render titles
 *    whose styles have no explicit color.
 */
function injectBasicTitleTemplate(item: FcpxmlTimelineItemIr): FcpxmlTimelineItemIr {
  if (item.type !== 'title') return item
  // Only inject when there's actual text content. Bare `<title/>`
  // items (the rare advanced case where the agent has done its own
  // homework) pass through unmodified.
  const hasTextContent =
    (item.textRuns && item.textRuns.length > 0) ||
    (item.textStyleDefs && item.textStyleDefs.length > 0)
  if (!hasTextContent) return item

  const result: FcpxmlTimelineItemIr = { ...item }

  // Title params — only inject when the agent hasn't supplied any.
  // Mixed shapes (some canonical, some flat) get the flat values
  // promoted INTO the canonical set.
  if (!item.titleParams || item.titleParams.length === 0) {
    result.titleParams = [
      {
        name: BASIC_TITLE_PARAMS.position.name,
        key: BASIC_TITLE_PARAMS.position.key,
        value: item.position || BASIC_TITLE_PARAMS.position.defaultValue
      },
      {
        name: BASIC_TITLE_PARAMS.flatten.name,
        key: BASIC_TITLE_PARAMS.flatten.key,
        value: BASIC_TITLE_PARAMS.flatten.defaultValue
      },
      {
        name: BASIC_TITLE_PARAMS.alignment.name,
        key: BASIC_TITLE_PARAMS.alignment.key,
        value: mapAlignmentToBasicTitleParam(item.alignment)
      },
      {
        name: BASIC_TITLE_PARAMS.disableDRT.name,
        key: BASIC_TITLE_PARAMS.disableDRT.key,
        value: BASIC_TITLE_PARAMS.disableDRT.defaultValue
      }
    ]
  }

  // Text-style-defs: fill required defaults. White text on every
  // style def that lacks a color (the most common omission); Regular
  // fontFace when missing. Keep agent-supplied values intact.
  if (item.textStyleDefs && item.textStyleDefs.length > 0) {
    result.textStyleDefs = item.textStyleDefs.map((def) => ({
      ...def,
      fontFace: def.fontFace || 'Regular',
      fontColor: def.fontColor || '1 1 1 1'
    }))
  }

  return result
}

function coerceTitleFlatFields(item: FcpxmlTimelineItemIr): FcpxmlTimelineItemIr {
  if (item.type !== 'title') return item
  if (
    (item.textRuns && item.textRuns.length > 0) ||
    (item.textStyleDefs && item.textStyleDefs.length > 0) ||
    (item.titleParams && item.titleParams.length > 0)
  ) {
    return item
  }
  const hasFlat =
    item.text ||
    item.font ||
    item.fontSize ||
    item.fontFace ||
    item.fontColor ||
    item.alignment ||
    item.position
  if (!hasFlat) return item
  // Single generated style def + run. The id is namespaced so it
  // doesn't collide with agent-authored ones.
  const styleId = 'taskwraith-flat-title-style'
  const promoted: FcpxmlTimelineItemIr = { ...item }
  if (item.text) {
    promoted.textRuns = [{ text: item.text, styleRef: styleId }]
  }
  if (item.font || item.fontSize || item.fontFace || item.fontColor || item.alignment) {
    promoted.textStyleDefs = [
      {
        id: styleId,
        font: item.font,
        fontSize: item.fontSize,
        fontFace: item.fontFace,
        fontColor: item.fontColor,
        alignment: item.alignment
      }
    ]
  }
  // Phase K11 — Position is intentionally NOT promoted to titleParams
  // here. `injectBasicTitleTemplate` owns Position emission (reading
  // `item.position` itself) so the canonical Apple-internal `key` is
  // attached. Promoting Position here would create a partial
  // titleParams that injectBasicTitleTemplate treats as "agent
  // supplied — leave alone" and the canonical key would be lost.
  return promoted
}

function emitAttrs(pairs: Array<[string, string | undefined]>): string {
  const parts: string[] = []
  for (const [name, value] of pairs) {
    if (value === undefined || value === '') continue
    parts.push(`${name}="${escapeXmlText(value)}"`)
  }
  return parts.length ? ' ' + parts.join(' ') : ''
}

/**
 * Phase K2 — emit a valid FCPXML 1.13 document from a timeline IR.
 *
 * See {@link FcpxmlTimelineWriterInput} for the fidelity envelope and
 * the supported input shape (full IR or minimal subset).
 */
export function serializeFcpxmlTimelineIr(
  input: FcpxmlTimelineWriterInput
): FcpxmlTimelineWriterResult {
  const ir = input.ir
  const version = ir.version || '1.13'
  const indent = input.indent ?? '  '
  const assets = ir.resources?.assets || []
  const formats = ir.resources?.formats || []
  const effects = ir.resources?.effects || []
  const projects = ir.projects || []
  const warnings: string[] = []

  let timelineItemCount = 0
  let markerCount = 0

  // FCPXML's resource ordering convention is format → asset → effect.
  // The DTD doesn't strictly require it but FCP's importer reads
  // resources left-to-right and resolves refs as it goes, so an asset
  // that references a format-id must come AFTER its format. Keeping
  // formats first eliminates that whole class of "ref not found"
  // surprises during import.
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<!DOCTYPE fcpxml>')
  lines.push(`<fcpxml version="${escapeXmlText(version)}">`)
  lines.push(`${indent}<resources>`)
  for (const format of formats) {
    lines.push(
      `${indent}${indent}<format${emitAttrs([
        ['id', format.id],
        ['name', format.name],
        ['width', format.width],
        ['height', format.height],
        ['frameDuration', format.frameDuration],
        ['colorSpace', format.colorSpace]
      ])}/>`
    )
  }
  for (const asset of assets) {
    // Phase K7 — FCPXML DTD compliance. The DTD declares
    //   <!ELEMENT asset (media-rep+, metadata?)>
    // i.e. every asset MUST contain at least one <media-rep>. The DTD
    // does NOT declare `src` or `role` as attributes of <asset>; both
    // belong on the inner media-rep (src) or on the asset-clip that
    // references the asset (role). Earlier K2 emission put src on the
    // asset element and skipped media-rep entirely — DTD-invalid on
    // both counts, even though tolerant XML parsers accepted it.
    //
    // The IR's `asset.src` is treated as the media-rep `src`. When
    // missing we synthesise a stub `file://` URL pointing at a
    // workspace placeholder so the emit still validates structurally
    // (FCP will surface "media offline" rather than reject the import).
    const mediaRepSrc =
      asset.src && asset.src.length > 0
        ? asset.src
        : `file:///taskwraith-placeholder/${encodeURIComponent(asset.id || 'asset')}.mov`
    if (!asset.src) {
      warnings.push(
        `Asset "${asset.id}" had no src; emitted a placeholder media-rep src so the document still validates. ` +
          'FCP will mark the clip as offline media until you point the asset at a real file.'
      )
    }
    // K8.1 — honor IR-supplied hasVideo/hasAudio when present so
    // audio-only assets (hasVideo=0) emit correctly. K7 hardcoded
    // both to "1" to force FCP into video-asset interpretation; that
    // helped slot non-AV-aware IRs into video tracks but blocked
    // honest audio-only declarations. Defaults stay "1" when the IR
    // doesn't specify, preserving the K7 behaviour for callers who
    // don't think about track presence.
    const assetHasVideo = normaliseTrackFlag(asset.hasVideo, '1')
    const assetHasAudio = normaliseTrackFlag(asset.hasAudio, '1')
    lines.push(
      `${indent}${indent}<asset${emitAttrs([
        ['id', asset.id],
        ['name', asset.name],
        ['uid', asset.uid],
        ['duration', asset.duration],
        ['start', asset.start],
        ['format', asset.format],
        ['hasVideo', assetHasVideo],
        ['hasAudio', assetHasAudio]
      ])}>`
    )
    lines.push(
      `${indent}${indent}${indent}<media-rep${emitAttrs([
        ['kind', 'original-media'],
        ['src', mediaRepSrc]
      ])}/>`
    )
    lines.push(`${indent}${indent}</asset>`)
  }
  for (const effect of effects) {
    lines.push(
      `${indent}${indent}<effect${emitAttrs([
        ['id', effect.id],
        ['name', effect.name],
        ['uid', effect.uid]
      ])}/>`
    )
  }
  lines.push(`${indent}</resources>`)

  // Library wraps every event. The IR carries a per-project eventName
  // string, so projects sharing an event get folded back together;
  // projects with distinct eventNames each get their own <event>. A
  // missing eventName falls into a synthesized "TaskWraith Drafts" event
  // so the output validates against importers that require non-empty
  // event names.
  if (projects.length > 0) {
    lines.push(`${indent}<library>`)
    const projectsByEvent = new Map<string, FcpxmlProjectIr[]>()
    for (const project of projects) {
      const eventKey = project.eventName || 'TaskWraith Drafts'
      const bucket = projectsByEvent.get(eventKey) || []
      bucket.push(project)
      projectsByEvent.set(eventKey, bucket)
    }
    for (const [eventName, eventProjects] of projectsByEvent) {
      lines.push(`${indent}${indent}<event name="${escapeXmlText(eventName)}">`)
      for (const project of eventProjects) {
        lines.push(`${indent}${indent}${indent}<project${emitAttrs([['name', project.name]])}>`)
        // Phase K7 — DTD requires <project> to contain exactly one
        // <sequence>, and <sequence> requires a `format` IDREF
        // (%media_attrs;). If the IR omits either, we synthesise the
        // minimum-valid skeleton so FCP's importer accepts the doc.
        // The agent gets a warning so it can correct the IR for next
        // time — silently filling in defaults forever would hide bugs.
        let seq: FcpxmlSequenceIr | undefined = project.sequence
        if (!seq) {
          warnings.push(
            `Project "${project.name || '(unnamed)'}" had no sequence; emitted an empty sequence so the document validates. ` +
              'The DTD requires <project> to contain exactly one <sequence>.'
          )
          seq = { spine: [], markers: [] }
        }
        // Determine the format ref — sequence.format wins, else the
        // first declared format in resources, else synthesise an
        // emergency "TaskWraith fallback" format declared inline.
        let sequenceFormatRef = seq.format
        if (!sequenceFormatRef) {
          if (formats.length > 0) {
            sequenceFormatRef = formats[0].id
            warnings.push(
              `Sequence in project "${project.name || '(unnamed)'}" had no format ref; defaulted to "${sequenceFormatRef}" (first format in resources).`
            )
          } else {
            // No formats anywhere — the document is missing the
            // resource that <sequence format=...> would point at.
            // Rather than emit an unresolved IDREF (which xmllint
            // catches with a fatal error), surface a writer warning
            // and skip the format attr. FCP will reject — but at
            // least the agent sees the warning, not a confusing DTD
            // error from FCP itself.
            warnings.push(
              `Sequence in project "${project.name || '(unnamed)'}" has no format ref and no <format> resources are declared. ` +
                'The DTD requires <sequence format="..."/> to reference an existing <format>. Add a <format> to resources before importing.'
            )
          }
        }
        // Phase K8 — resolve the canonical denominator for THIS
        // sequence's time-base and canonicalize every emitted time
        // string against it. FCP's importer doesn't simplify
        // rationals; pre-K8 emission of "5/4s" tripped the
        // "not on an edit frame boundary" warning even though the
        // value was a clean 30 frames at 24fps. Same number, more
        // verbose denominator, no warning.
        const canonDen = getSequenceCanonicalDenominator(sequenceFormatRef, formats)
        const t = (s: string | undefined) =>
          canonDen ? canonicalizeFcpxmlTime(s, canonDen) : s || ''
        lines.push(
          `${indent}${indent}${indent}${indent}<sequence${emitAttrs([
            ['name', seq.name],
            ['duration', t(seq.duration)],
            ['format', sequenceFormatRef],
            ['tcStart', t(seq.tcStart)],
            ['tcFormat', seq.tcFormat]
          ])}>`
        )
        lines.push(`${indent}${indent}${indent}${indent}${indent}<spine>`)
        for (const rawItem of seq.spine) {
          // K8.1 — Coerce title flat fields (text/font/fontSize/
          // alignment/position) into the canonical textRuns +
          // textStyleDefs + titleParams shape so agents who don't
          // know the K8 canonical IR succeed anyway.
          // K11 — Then inject the four canonical Basic Title params
          // (Position/Flatten/Alignment/disableDRT with their
          // Apple-internal keys) + fontFace/fontColor defaults so
          // FCP actually renders the title instead of creating a
          // bound-to-nothing element.
          const item = injectBasicTitleTemplate(coerceTitleFlatFields(rawItem))
          timelineItemCount += 1
          markerCount += item.markers.length + item.captions.length
          if (!item.duration) {
            warnings.push(
              `Spine item index ${item.index} (${item.type}${item.name ? ` "${item.name}"` : ''}) has no duration. ` +
                'FCP will likely reject the import; supply a duration like "5s" or "120/24000s".'
            )
          }
          const isTitle = item.type === 'title'
          const hasTitleContent =
            isTitle &&
            ((item.textRuns && item.textRuns.length > 0) ||
              (item.textStyleDefs && item.textStyleDefs.length > 0) ||
              (item.titleParams && item.titleParams.length > 0))
          const hasChildren = item.markers.length > 0 || item.captions.length > 0 || hasTitleContent
          // K8.1 — asset-clip uses audioRole/videoRole per the DTD;
          // a generic `role` attribute on <asset-clip> is rejected
          // by the importer (this was the Codex 1.4 miss). Other
          // spine item types (clip, gap, title, etc.) still use the
          // generic `role` attribute.
          const isAssetClip = item.type === 'asset-clip'
          const splitRoles = isAssetClip
            ? {
                audioRole: item.audioRole ?? splitAssetClipRole(item.role).audioRole,
                videoRole: item.videoRole ?? splitAssetClipRole(item.role).videoRole
              }
            : null
          const roleAttrs: Array<[string, string | undefined]> = splitRoles
            ? [
                ['audioRole', splitRoles.audioRole],
                ['videoRole', splitRoles.videoRole]
              ]
            : [['role', item.role]]
          const headerAttrs = emitAttrs([
            ['name', item.name],
            ['ref', item.ref],
            ['offset', t(item.offset)],
            ['start', t(item.start)],
            ['duration', t(item.duration)],
            ['lane', item.lane],
            ...roleAttrs,
            ['format', item.format]
          ])
          if (!hasChildren) {
            lines.push(
              `${indent}${indent}${indent}${indent}${indent}${indent}<${item.type}${headerAttrs}/>`
            )
            continue
          }
          lines.push(
            `${indent}${indent}${indent}${indent}${indent}${indent}<${item.type}${headerAttrs}>`
          )
          // Title-specific children. FCPXML orders these as:
          //   <param>* before <text>? before <text-style-def>*
          // (the DTD is permissive but FCP's importer is sensitive
          // to param ordering for the title preset to bind right).
          if (item.titleParams) {
            for (const param of item.titleParams) {
              lines.push(
                `${indent}${indent}${indent}${indent}${indent}${indent}${indent}<param${emitAttrs([
                  ['name', param.name],
                  ['key', param.key],
                  ['value', param.value]
                ])}/>`
              )
            }
          }
          if (item.textRuns && item.textRuns.length > 0) {
            lines.push(`${indent}${indent}${indent}${indent}${indent}${indent}${indent}<text>`)
            for (const run of item.textRuns) {
              if (run.styleRef) {
                lines.push(
                  `${indent}${indent}${indent}${indent}${indent}${indent}${indent}${indent}<text-style ref="${escapeXmlText(run.styleRef)}">${escapeXmlText(run.text)}</text-style>`
                )
              } else {
                lines.push(
                  `${indent}${indent}${indent}${indent}${indent}${indent}${indent}${indent}${escapeXmlText(run.text)}`
                )
              }
            }
            lines.push(`${indent}${indent}${indent}${indent}${indent}${indent}${indent}</text>`)
          }
          if (item.textStyleDefs) {
            for (const def of item.textStyleDefs) {
              lines.push(
                `${indent}${indent}${indent}${indent}${indent}${indent}${indent}<text-style-def${emitAttrs(
                  [['id', def.id]]
                )}>`
              )
              lines.push(
                `${indent}${indent}${indent}${indent}${indent}${indent}${indent}${indent}<text-style${emitAttrs(
                  [
                    ['font', def.font],
                    ['fontSize', def.fontSize],
                    ['fontFace', def.fontFace],
                    ['fontColor', def.fontColor],
                    ['alignment', def.alignment]
                  ]
                )}/>`
              )
              lines.push(
                `${indent}${indent}${indent}${indent}${indent}${indent}${indent}</text-style-def>`
              )
            }
          }
          for (const marker of item.markers) {
            lines.push(
              `${indent}${indent}${indent}${indent}${indent}${indent}${indent}<${marker.type}${emitAttrs(
                [
                  ['start', t(marker.start)],
                  ['duration', t(marker.duration)],
                  ['value', marker.value],
                  ['note', marker.note],
                  ['role', marker.role]
                ]
              )}/>`
            )
          }
          for (const caption of item.captions) {
            lines.push(
              `${indent}${indent}${indent}${indent}${indent}${indent}${indent}<caption${emitAttrs([
                ['start', t(caption.start)],
                ['duration', t(caption.duration)],
                ['value', caption.value],
                ['note', caption.note],
                ['role', caption.role]
              ])}/>`
            )
          }
          lines.push(`${indent}${indent}${indent}${indent}${indent}${indent}</${item.type}>`)
        }
        lines.push(`${indent}${indent}${indent}${indent}${indent}</spine>`)
        // Sequence-level markers ride at the spine sibling level.
        for (const marker of seq.markers) {
          markerCount += 1
          lines.push(
            `${indent}${indent}${indent}${indent}${indent}<${marker.type}${emitAttrs([
              ['start', t(marker.start)],
              ['duration', t(marker.duration)],
              ['value', marker.value],
              ['note', marker.note],
              ['role', marker.role]
            ])}/>`
          )
        }
        lines.push(`${indent}${indent}${indent}${indent}</sequence>`)
        lines.push(`${indent}${indent}${indent}</project>`)
      }
      lines.push(`${indent}${indent}</event>`)
    }
    lines.push(`${indent}</library>`)
  }

  lines.push('</fcpxml>')
  // Trailing newline — POSIX-friendly, matches Final Cut's own export.
  const text = lines.join('\n') + '\n'

  return {
    ok: true,
    text,
    summary: {
      assetCount: assets.length,
      formatCount: formats.length,
      effectCount: effects.length,
      projectCount: projects.length,
      timelineItemCount,
      markerCount
    },
    warnings
  }
}

export function buildFcpxmlTimelineDiffPlan(
  input: FcpxmlTimelineDiffInput
): FcpxmlTimelineDiffPlan {
  const generatedAt = input.now || new Date().toISOString()
  const before = buildFcpxmlTimelineIr({
    path: input.beforePath,
    text: input.beforeText,
    truncated: input.beforeTruncated,
    now: generatedAt
  })
  const after = buildFcpxmlTimelineIr({
    path: input.afterPath,
    text: input.afterText,
    truncated: input.afterTruncated,
    now: generatedAt
  })
  const projects = diffTimelineProjects(before, after)
  const affectedResources = collectAffectedResources(before, after, projects)
  const addedItemCount = projects.reduce((count, project) => count + project.addedItems.length, 0)
  const removedItemCount = projects.reduce(
    (count, project) => count + project.removedItems.length,
    0
  )
  const changedItemCount = projects.reduce(
    (count, project) => count + project.changedItems.length,
    0
  )
  const warnings = [
    ...before.warnings.map((warning) => `Before: ${warning}`),
    ...after.warnings.map((warning) => `After: ${warning}`)
  ]
  const summary: Record<string, number | string | boolean> = {
    projectCountBefore: before.projects.length,
    projectCountAfter: after.projects.length,
    addedItemCount,
    removedItemCount,
    changedItemCount,
    affectedAssetCount: affectedResources.assets.length,
    affectedEffectCount: affectedResources.effects.length,
    beforeTruncated: Boolean(input.beforeTruncated),
    afterTruncated: Boolean(input.afterTruncated)
  }
  const sidecarDocument = {
    schema: 'taskwraith-fcpxml-diff-plan-v1',
    generatedAt,
    appId: 'final-cut-pro',
    kind: 'fcpxml',
    beforePath: input.beforePath,
    afterPath: input.afterPath,
    summary,
    affectedResources,
    projects,
    warnings
  }

  return {
    ok: true,
    generatedAt,
    appId: 'final-cut-pro',
    kind: 'fcpxml',
    readOnly: true,
    diff: 'fcpxml-timeline-diff-v1',
    beforePath: input.beforePath,
    afterPath: input.afterPath,
    summary,
    affectedResources,
    projects,
    sidecar: {
      schema: 'taskwraith-fcpxml-diff-plan-v1',
      recommendedPath: recommendedTimelineSidecarPath(input.afterPath),
      document: sidecarDocument
    },
    warnings
  }
}

function matchingDefinitions(appId?: CreativeAppId): CreativeAppDefinition[] {
  return appId
    ? CREATIVE_APP_DEFINITIONS.filter((definition) => definition.id === appId)
    : CREATIVE_APP_DEFINITIONS
}

function inferCreativeProjectKind(
  input: CreativeProjectSnapshotInput,
  extension: string
): {
  appId?: CreativeAppId
  kind: CreativeProjectKind
  transport: CreativeAppTransport
  summary: string
} {
  if (input.isDirectory) {
    if (extension === '.fcpbundle') {
      return {
        appId: 'final-cut-pro',
        kind: 'final-cut-library',
        transport: 'exchange-file',
        summary:
          'Final Cut Pro library package; package contents are not inspected by this read-only snapshot.'
      }
    }
    if (extension === '.fcpxmld') {
      return {
        appId: 'final-cut-pro',
        kind: 'final-cut-xml-bundle',
        transport: 'exchange-file',
        summary:
          'Final Cut Pro XML bundle; bundle contents are not inspected by this read-only snapshot.'
      }
    }
    if (extension === '.logicx') {
      return {
        appId: 'logic-pro',
        kind: 'logic-package',
        transport: 'exchange-file',
        summary:
          'Logic Pro project package; package contents are not treated as a public project API.'
      }
    }
  }

  if (extension === '.fcpxml' || textIncludes(input.text, '<fcpxml')) {
    return {
      appId: 'final-cut-pro',
      kind: 'fcpxml',
      transport: 'exchange-file',
      summary: 'Final Cut Pro XML interchange document.'
    }
  }
  if (extension === '.musicxml' || textIncludes(input.text, '<score-partwise')) {
    return {
      appId: 'logic-pro',
      kind: 'musicxml',
      transport: 'exchange-file',
      summary: 'MusicXML score interchange document suitable for Logic Pro file workflows.'
    }
  }
  if (extension === '.mid' || extension === '.midi' || startsWithAscii(input.bytes, 'MThd')) {
    return {
      appId: 'logic-pro',
      kind: 'midi',
      transport: 'exchange-file',
      summary: 'Standard MIDI file for Logic Pro import or audition workflows.'
    }
  }
  if (
    extension === '.blend' ||
    extension === '.blend1' ||
    startsWithAscii(input.bytes, 'BLENDER')
  ) {
    return {
      appId: 'blender',
      kind: 'blender-binary',
      transport: 'cli',
      summary:
        'Blender binary project; deep scene inspection requires a Blender batch or live bridge.'
    }
  }
  if (
    extension === '.fbx' ||
    extension === '.obj' ||
    extension === '.gltf' ||
    extension === '.glb'
  ) {
    return {
      appId: 'blender',
      kind: 'blender-exchange',
      transport: 'exchange-file',
      summary: 'Blender-compatible asset exchange file.'
    }
  }
  return {
    kind: 'unknown',
    transport: 'exchange-file',
    summary: 'Creative project type is not recognized by the current adapter registry.'
  }
}

function buildProjectStats(
  kind: CreativeProjectKind,
  input: CreativeProjectSnapshotInput
): Record<string, number | string | boolean> {
  if (kind === 'fcpxml') {
    const text = input.text || ''
    return {
      version: firstAttribute(text, 'fcpxml', 'version') || 'unknown',
      libraries: countTag(text, 'library'),
      events: countTag(text, 'event'),
      projects: countTag(text, 'project'),
      sequences: countTag(text, 'sequence'),
      assets: countTag(text, 'asset'),
      clips: countAnyTag(text, ['clip', 'asset-clip', 'sync-clip', 'mc-clip']),
      markers: countTag(text, 'marker'),
      captions: countTag(text, 'caption'),
      effects: countTag(text, 'effect')
    }
  }
  if (kind === 'musicxml') {
    const text = input.text || ''
    return {
      title: tagText(text, 'work-title') || tagText(text, 'movement-title') || 'unknown',
      parts: countTag(text, 'part'),
      measures: countTag(text, 'measure'),
      notes: countTag(text, 'note'),
      harmonies: countTag(text, 'harmony')
    }
  }
  if (kind === 'midi') {
    return midiStats(input.bytes)
  }
  if (kind === 'blender-binary') {
    return blenderStats(input.bytes)
  }
  return {
    directory: input.isDirectory
  }
}

function buildProjectWarnings(
  kind: CreativeProjectKind,
  input: CreativeProjectSnapshotInput
): string[] {
  const warnings: string[] = []
  if (input.text === undefined && (kind === 'fcpxml' || kind === 'musicxml')) {
    warnings.push('Text content was not loaded, so XML element counts are unavailable.')
  }
  if (kind === 'final-cut-library') {
    warnings.push('TaskWraith does not inspect or mutate .fcpbundle internals in this snapshot.')
  }
  if (kind === 'logic-package') {
    warnings.push(
      'TaskWraith does not inspect or mutate .logicx internals because they are not a public project API.'
    )
  }
  if (kind === 'blender-binary') {
    warnings.push(
      'Use a future Blender batch/live adapter for authoritative scene graph inspection.'
    )
  }
  if (kind === 'unknown') {
    warnings.push('No adapter-specific parser matched this path.')
  }
  return warnings
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith('.') || !trimmed ? trimmed : `.${trimmed}`
}

function extensionFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() || ''
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index) : ''
}

function textIncludes(text: string | undefined, needle: string): boolean {
  return Boolean(text && text.toLowerCase().includes(needle.toLowerCase()))
}

function startsWithAscii(bytes: Uint8Array | undefined, prefix: string): boolean {
  if (!bytes || bytes.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false
  }
  return true
}

function countTag(text: string, tagName: string): number {
  return countAnyTag(text, [tagName])
}

function countAnyTag(text: string, tagNames: string[]): number {
  if (!text) return 0
  return tagNames.reduce((count, tagName) => {
    const pattern = new RegExp(`<${tagName}(\\s|>|/)`, 'gi')
    return count + (text.match(pattern)?.length || 0)
  }, 0)
}

function firstAttribute(text: string, tagName: string, attributeName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*\\s${attributeName}=["']([^"']+)["']`, 'i')
  return text.match(pattern)?.[1]
}

function tagText(text: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([^<]{1,200})</${tagName}>`, 'i')
  return text.match(pattern)?.[1]?.trim()
}

function collectAttributeValues(text: string, attributeName: string): string[] {
  if (!text) return []
  const pattern = new RegExp(`\\s${attributeName}=["']([^"']+)["']`, 'gi')
  const values: string[] = []
  for (const match of text.matchAll(pattern)) {
    if (match[1]) values.push(match[1])
  }
  return values
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value)
    } else {
      seen.add(value)
    }
  }
  return [...duplicates]
}

function countIssuesBySeverity(
  issues: CreativeValidationIssue[]
): Record<CreativeValidationSeverity, number> {
  return {
    error: issues.filter((issue) => issue.severity === 'error').length,
    warning: issues.filter((issue) => issue.severity === 'warning').length,
    info: issues.filter((issue) => issue.severity === 'info').length
  }
}

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  parent?: XmlNode
}

function parseXmlDocument(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [] }
  const stack: XmlNode[] = [root]
  const tagPattern = /<([^!?][^>]*)>/g
  for (const match of text.matchAll(tagPattern)) {
    const raw = match[1]?.trim() || ''
    if (!raw || raw.startsWith('!--')) continue
    if (raw.startsWith('/')) {
      const closingName = raw.slice(1).trim().split(/\s+/)[0]
      while (stack.length > 1) {
        const current = stack.pop()
        if (current?.name === closingName) break
      }
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1).trim() : raw
    const name = body.split(/\s+/)[0]
    if (!name) continue
    const node: XmlNode = {
      name,
      attrs: parseXmlAttributes(body.slice(name.length)),
      children: [],
      parent: stack[stack.length - 1]
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]
    const value = match[3] ?? match[4] ?? ''
    attrs[name] = decodeXmlAttribute(value)
  }
  return attrs
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function firstDescendant(node: XmlNode, name: string): XmlNode | undefined {
  return descendants(node, name)[0]
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const matches: XmlNode[] = []
  for (const child of node.children) {
    if (child.name === name) matches.push(child)
    matches.push(...descendants(child, name))
  }
  return matches
}

function firstChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name)
}

function nearestAncestorName(node: XmlNode, ancestorName: string): string | undefined {
  let current = node.parent
  while (current) {
    if (current.name === ancestorName) return current.attrs.name
    current = current.parent
  }
  return undefined
}

function assetToIr(node: XmlNode): FcpxmlResourceIr {
  // Phase K7 — the FCPXML 1.13 DTD declares `src` on <media-rep>, not
  // on <asset>. Older docs (and some non-conformant exporters) put
  // src directly on <asset>; we read either, preferring the inner
  // <media-rep src=...> when both are present so we match the spec's
  // source-of-truth. The IR collapses both into a single `src` field
  // because consumers don't care which element it came from.
  const mediaReps = descendants(node, 'media-rep')
  const firstMediaRepSrc = mediaReps[0]?.attrs.src
  return {
    id: node.attrs.id || '',
    name: node.attrs.name,
    uid: node.attrs.uid,
    src: firstMediaRepSrc || node.attrs.src,
    duration: node.attrs.duration,
    start: node.attrs.start,
    format: node.attrs.format,
    role: node.attrs.role,
    mediaRepCount: mediaReps.length
  }
}

function formatToIr(node: XmlNode): FcpxmlFormatIr {
  return {
    id: node.attrs.id || '',
    name: node.attrs.name,
    width: node.attrs.width,
    height: node.attrs.height,
    frameDuration: node.attrs.frameDuration,
    colorSpace: node.attrs.colorSpace
  }
}

function effectToIr(node: XmlNode): FcpxmlEffectIr {
  return {
    id: node.attrs.id || '',
    name: node.attrs.name,
    uid: node.attrs.uid
  }
}

function sequenceToIr(
  node: XmlNode,
  assetNameById: Map<string, string>,
  effectNameById: Map<string, string>
): FcpxmlSequenceIr {
  const spine = firstChild(node, 'spine')
  const spineItems = spine
    ? spine.children
        .filter((child) => isTimelineItemNode(child.name))
        .map((child, index) => timelineItemToIr(child, index, assetNameById, effectNameById))
    : []
  return {
    name: node.attrs.name,
    duration: node.attrs.duration,
    format: node.attrs.format,
    tcStart: node.attrs.tcStart,
    tcFormat: node.attrs.tcFormat,
    spine: spineItems,
    markers: collectTimelineMarkers(node)
  }
}

function timelineItemToIr(
  node: XmlNode,
  index: number,
  assetNameById: Map<string, string>,
  effectNameById: Map<string, string>
): FcpxmlTimelineItemIr {
  const ref = node.attrs.ref
  const item: FcpxmlTimelineItemIr = {
    index,
    type: node.name,
    name: node.attrs.name,
    ref,
    refName: ref ? assetNameById.get(ref) || effectNameById.get(ref) : undefined,
    offset: node.attrs.offset,
    start: node.attrs.start,
    duration: node.attrs.duration,
    lane: node.attrs.lane,
    role: node.attrs.role,
    format: node.attrs.format,
    markers: collectTimelineMarkers(node).filter((marker) => marker.type !== 'caption'),
    captions: collectTimelineMarkers(node).filter((marker) => marker.type === 'caption')
  }
  // Phase K8 — pull title-specific rich content out of the <title>'s
  // children when present. Other item types ignore these fields.
  if (node.name === 'title') {
    const textNodes = firstChild(node, 'text')
    if (textNodes) {
      const runs: FcpxmlTextRun[] = []
      for (const child of textNodes.children) {
        if (child.name === 'text-style') {
          // <text-style ref="ts1">literal text</text-style> — but our
          // XmlNode parser doesn't capture text content between tags
          // by default. We approximate via the `ref` attr and a
          // best-effort text pull. For now we capture the ref; the
          // literal text remains in the source XML and is preserved
          // by FCP's importer because we re-emit the same structure.
          runs.push({ text: '', styleRef: child.attrs.ref })
        }
      }
      if (runs.length > 0) item.textRuns = runs
    }
    const styleDefNodes = node.children.filter((c) => c.name === 'text-style-def')
    if (styleDefNodes.length > 0) {
      item.textStyleDefs = styleDefNodes.map((defNode) => {
        const inner = firstChild(defNode, 'text-style')
        return {
          id: defNode.attrs.id || '',
          font: inner?.attrs.font,
          fontSize: inner?.attrs.fontSize,
          fontFace: inner?.attrs.fontFace,
          fontColor: inner?.attrs.fontColor,
          alignment: inner?.attrs.alignment
        }
      })
    }
    const paramNodes = node.children.filter((c) => c.name === 'param')
    if (paramNodes.length > 0) {
      item.titleParams = paramNodes.map((p) => ({
        name: p.attrs.name || '',
        key: p.attrs.key,
        value: p.attrs.value || ''
      }))
    }
  }
  return item
}

function isTimelineItemNode(name: string): boolean {
  return [
    'asset-clip',
    'clip',
    'sync-clip',
    'mc-clip',
    'ref-clip',
    'gap',
    'title',
    'generator',
    'transition'
  ].includes(name)
}

function collectTimelineMarkers(node: XmlNode): FcpxmlTimelineMarkerIr[] {
  return [
    ...descendants(node, 'marker').map((marker) => markerToIr(marker, 'marker')),
    ...descendants(node, 'chapter-marker').map((marker) => markerToIr(marker, 'chapter-marker')),
    ...descendants(node, 'caption').map((marker) => markerToIr(marker, 'caption'))
  ]
}

function markerToIr(node: XmlNode, type: FcpxmlTimelineMarkerIr['type']): FcpxmlTimelineMarkerIr {
  return {
    type,
    value: node.attrs.value,
    start: node.attrs.start,
    duration: node.attrs.duration,
    note: node.attrs.note,
    role: node.attrs.role
  }
}

const TIMELINE_DIFF_FIELDS: Array<keyof FcpxmlTimelineDiffItemSummary> = [
  'type',
  'name',
  'ref',
  'refName',
  'offset',
  'start',
  'duration',
  'lane',
  'role',
  'format',
  'markerCount',
  'captionCount'
]

function diffTimelineProjects(
  before: FcpxmlTimelineIr,
  after: FcpxmlTimelineIr
): FcpxmlTimelineProjectDiffIr[] {
  const count = Math.max(before.projects.length, after.projects.length)
  const projects: FcpxmlTimelineProjectDiffIr[] = []
  for (let index = 0; index < count; index++) {
    const beforeProject = before.projects[index]
    const afterProject = after.projects[index]
    const projectDiff = diffTimelineProject(index, beforeProject, afterProject)
    if (
      projectDiff.fields.length > 0 ||
      projectDiff.addedItems.length > 0 ||
      projectDiff.removedItems.length > 0 ||
      projectDiff.changedItems.length > 0
    ) {
      projects.push(projectDiff)
    }
  }
  return projects
}

function diffTimelineProject(
  index: number,
  beforeProject: FcpxmlProjectIr | undefined,
  afterProject: FcpxmlProjectIr | undefined
): FcpxmlTimelineProjectDiffIr {
  const beforeItems = beforeProject?.sequence?.spine || []
  const afterItems = afterProject?.sequence?.spine || []
  const count = Math.max(beforeItems.length, afterItems.length)
  const addedItems: FcpxmlTimelineDiffItemSummary[] = []
  const removedItems: FcpxmlTimelineDiffItemSummary[] = []
  const changedItems: FcpxmlTimelineChangedItemIr[] = []

  for (let itemIndex = 0; itemIndex < count; itemIndex++) {
    const beforeItem = beforeItems[itemIndex]
    const afterItem = afterItems[itemIndex]
    if (!beforeItem && afterItem) {
      addedItems.push(summarizeTimelineItem(afterItem))
      continue
    }
    if (beforeItem && !afterItem) {
      removedItems.push(summarizeTimelineItem(beforeItem))
      continue
    }
    if (!beforeItem || !afterItem) continue
    const beforeSummary = summarizeTimelineItem(beforeItem)
    const afterSummary = summarizeTimelineItem(afterItem)
    const fields = changedTimelineFields(beforeSummary, afterSummary)
    if (fields.length > 0) {
      changedItems.push({
        index: itemIndex,
        fields,
        before: beforeSummary,
        after: afterSummary
      })
    }
  }

  return {
    index,
    fields: changedProjectFields(beforeProject, afterProject),
    beforeName: beforeProject?.name,
    afterName: afterProject?.name,
    eventName: afterProject?.eventName || beforeProject?.eventName,
    addedItems,
    removedItems,
    changedItems
  }
}

function changedProjectFields(
  beforeProject: FcpxmlProjectIr | undefined,
  afterProject: FcpxmlProjectIr | undefined
): string[] {
  const beforeSequence = beforeProject?.sequence
  const afterSequence = afterProject?.sequence
  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ['project.name', beforeProject?.name, afterProject?.name],
    ['event.name', beforeProject?.eventName, afterProject?.eventName],
    ['sequence.duration', beforeSequence?.duration, afterSequence?.duration],
    ['sequence.format', beforeSequence?.format, afterSequence?.format],
    ['sequence.tcStart', beforeSequence?.tcStart, afterSequence?.tcStart],
    ['sequence.tcFormat', beforeSequence?.tcFormat, afterSequence?.tcFormat]
  ]
  return pairs.filter(([, before, after]) => before !== after).map(([field]) => field)
}

function summarizeTimelineItem(item: FcpxmlTimelineItemIr): FcpxmlTimelineDiffItemSummary {
  return {
    index: item.index,
    type: item.type,
    name: item.name,
    ref: item.ref,
    refName: item.refName,
    offset: item.offset,
    start: item.start,
    duration: item.duration,
    lane: item.lane,
    role: item.role,
    format: item.format,
    markerCount: item.markers.length,
    captionCount: item.captions.length
  }
}

function changedTimelineFields(
  before: FcpxmlTimelineDiffItemSummary,
  after: FcpxmlTimelineDiffItemSummary
): string[] {
  return TIMELINE_DIFF_FIELDS.filter((field) => before[field] !== after[field]).map(String)
}

function collectAffectedResources(
  before: FcpxmlTimelineIr,
  after: FcpxmlTimelineIr,
  projects: FcpxmlTimelineProjectDiffIr[]
): FcpxmlTimelineDiffPlan['affectedResources'] {
  const assetsById = new Map<string, FcpxmlTimelineAffectedResourceIr>()
  const effectsById = new Map<string, FcpxmlTimelineAffectedResourceIr>()
  for (const ir of [before, after]) {
    for (const asset of ir.resources.assets) {
      assetsById.set(asset.id, { id: asset.id, name: asset.name, uid: asset.uid })
    }
    for (const effect of ir.resources.effects) {
      effectsById.set(effect.id, { id: effect.id, name: effect.name, uid: effect.uid })
    }
  }

  const affectedAssetIds = new Set<string>()
  const affectedEffectIds = new Set<string>()
  for (const project of projects) {
    const summaries = [
      ...project.addedItems,
      ...project.removedItems,
      ...project.changedItems.flatMap((item) => [item.before, item.after])
    ]
    for (const summary of summaries) {
      if (!summary.ref) continue
      if (assetsById.has(summary.ref)) affectedAssetIds.add(summary.ref)
      if (effectsById.has(summary.ref)) affectedEffectIds.add(summary.ref)
    }
  }

  return {
    assets: affectedResourceList(affectedAssetIds, assetsById),
    effects: affectedResourceList(affectedEffectIds, effectsById)
  }
}

function affectedResourceList(
  ids: Set<string>,
  resourcesById: Map<string, FcpxmlTimelineAffectedResourceIr>
): FcpxmlTimelineAffectedResourceIr[] {
  return [...ids]
    .map((id) => resourcesById.get(id) || { id })
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
}

function recommendedTimelineSidecarPath(path: string): string {
  return `${path}.taskwraith-timeline-diff.json`
}

function readUint16BE(bytes: Uint8Array, offset: number): number | undefined {
  if (bytes.length < offset + 2) return undefined
  return bytes[offset] * 256 + bytes[offset + 1]
}

function midiStats(bytes: Uint8Array | undefined): Record<string, number | string | boolean> {
  if (!startsWithAscii(bytes, 'MThd') || !bytes) {
    return { validHeader: false }
  }
  return {
    validHeader: true,
    format: readUint16BE(bytes, 8) ?? 'unknown',
    tracks: readUint16BE(bytes, 10) ?? 'unknown',
    division: readUint16BE(bytes, 12) ?? 'unknown'
  }
}

function blenderStats(bytes: Uint8Array | undefined): Record<string, number | string | boolean> {
  if (!startsWithAscii(bytes, 'BLENDER') || !bytes) {
    return { validHeader: false }
  }
  return {
    validHeader: true,
    pointerSize: bytes[7] === 45 ? 8 : bytes[7] === 95 ? 4 : 'unknown',
    endian: bytes[8] === 118 ? 'little' : bytes[8] === 86 ? 'big' : 'unknown',
    version: bytes.length >= 12 ? asciiSlice(bytes, 9, 12) : 'unknown'
  }
}

function asciiSlice(bytes: Uint8Array, start: number, end: number): string {
  return Array.from(bytes.slice(start, end))
    .map((byte) => String.fromCharCode(byte))
    .join('')
}

function statusForDefinition(
  definition: CreativeAppDefinition,
  input: CreativeAppProbeInput
): CreativeAppStatus {
  const attachedWindow =
    input.attachedWindow && windowMatchesDefinition(input.attachedWindow, definition)
      ? input.attachedWindow
      : undefined
  return {
    id: definition.id,
    label: definition.label,
    bundleIds: [...definition.bundleIds],
    installedHint: definition.commonAppPaths.some((path) => input.fileExists?.(path) === true),
    // K1 — true when any of the app's declared bundle IDs reports
    // as running via the daemon probe. `.some()` because some apps
    // ship multiple bundle IDs across versions (Logic Pro X vs
    // newer SKU, etc.) and we count any match as "running".
    runningHint: definition.bundleIds.some((id) => input.runningHint?.(id) === true),
    attached: Boolean(attachedWindow),
    attachedWindow,
    projectExtensions: [...definition.projectExtensions],
    transports: [...definition.transports],
    capabilityCount: definition.capabilities.length,
    riskTiers: [...new Set(definition.capabilities.map((capability) => capability.riskTier))],
    limitations: [...definition.limitations]
  }
}

function windowMatchesDefinition(
  windowMeta: CreativeAttachedWindowMeta,
  definition: CreativeAppDefinition
): boolean {
  if (windowMeta.bundleID && definition.bundleIds.includes(windowMeta.bundleID)) {
    return true
  }
  const applicationName = windowMeta.applicationName?.toLowerCase() || ''
  return Boolean(applicationName && definition.label.toLowerCase().includes(applicationName))
}

function cloneDefinition(definition: CreativeAppDefinition): CreativeAppDefinition {
  return {
    ...definition,
    bundleIds: [...definition.bundleIds],
    commonAppPaths: [...definition.commonAppPaths],
    projectExtensions: [...definition.projectExtensions],
    transports: [...definition.transports],
    capabilities: definition.capabilities.map((capability) => ({ ...capability })),
    prompts: [...definition.prompts],
    limitations: [...definition.limitations]
  }
}
