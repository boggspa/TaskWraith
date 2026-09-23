import type { TaskWraithMcpToolDefinition } from '../McpToolCatalog'

/** A compact front door; each operation still executes its original governed tool. */
export const COMPUTER_USE_TOOL_DEFINITION: TaskWraithMcpToolDefinition = {
  name: 'computer_use',
  description:
    'Use a browser or approved app window with one observe–act–observe interface. Start with list, open a URL (browser) or launchId (approved native window), then act using refs from the returned observation. Open, observe and successful actions return a fresh element tree and screenshot image when capture is permitted. Check action execution and observation separately; a capture failure does not mean an action failed. Browser coordinates are viewport CSS pixels, not image pixels; prefer refs. Native windows support observe/click/fill only, with an exact foreground-window lease, ref, expectedObservationId and expectedInputEpoch. Other browser actions are key, scroll, hover, select and navigate. No provider-specific model is required; visual reasoning requires a model/transport that accepts images. Each underlying operation keeps its own permission, human-takeover and approval checks. Stop and re-observe on refusal; never replay an unconfirmed action blindly.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list',
          'open',
          'observe',
          'click',
          'fill',
          'key',
          'scroll',
          'hover',
          'select',
          'navigate',
          'close'
        ]
      },
      canvasId: {
        type: 'string',
        minLength: 1,
        description: 'From list/open; required after opening.'
      },
      url: { type: 'string', minLength: 1, description: 'Browser URL for open or navigate.' },
      launchId: {
        type: 'string',
        minLength: 1,
        description: 'Managed app launch for open; omit url.'
      },
      ref: {
        type: 'string',
        minLength: 1,
        description: 'Element ref from the latest observation.'
      },
      selector: {
        type: 'string',
        minLength: 1,
        description: 'Browser CSS selector when no ref is available.'
      },
      x: {
        type: 'number',
        description: 'Browser viewport CSS x; never native-window coordinates.'
      },
      y: { type: 'number', description: 'Browser viewport CSS y.' },
      text: {
        type: 'string',
        description: 'Non-secret field value for fill or option for select.'
      },
      key: {
        type: 'string',
        description: 'Browser non-text key, e.g. Enter, Escape, Tab or ArrowDown.'
      },
      deltaX: { type: 'number', description: 'Horizontal scroll in CSS pixels.' },
      deltaY: { type: 'number', description: 'Vertical scroll in CSS pixels.' },
      expectedInputEpoch: {
        type: 'integer',
        minimum: 0,
        description: 'Latest observation inputEpoch.'
      },
      expectedObservationId: {
        type: 'string',
        minLength: 1,
        description: 'Latest native observationId.'
      },
      navigation: { type: 'string', enum: ['back', 'forward', 'reload', 'stop'] }
    },
    required: ['action'],
    additionalProperties: false,
    examples: [{ action: 'list' }, { action: 'open', url: 'https://example.com' }]
  }
}
