import { selectableProviderIds } from './settings/MainSanitizers'
import { TASKWRAITH_MCP_TOOLS, type TaskWraithMcpToolName } from './TaskWraithMcpTools'

export interface TaskWraithMcpToolDefinition {
  name: TaskWraithMcpToolName
  description?: string
  annotations?: Record<string, unknown>
  inputSchema?: Record<string, unknown>
}

export function createTaskWraithMcpToolDefinitions(): TaskWraithMcpToolDefinition[] {
  const definitions: TaskWraithMcpToolDefinition[] = [
    {
      name: 'run_shell_command',
      description:
        'Run a shell command in the active TaskWraith workspace after TaskWraith approval policy allows it.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: {
            type: 'string',
            description: 'Optional workspace-relative or in-workspace absolute cwd.'
          }
        },
        required: ['command']
      }
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file inside the active TaskWraith workspace after approval.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'replace',
      description:
        'Replace text in a UTF-8 file inside the active TaskWraith workspace after approval.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    },
    {
      name: 'read_file',
      description:
        'Read a UTF-8 text file inside the active TaskWraith workspace after tool policy allows it.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    },
    {
      name: 'list_directory',
      description:
        'List a directory inside the active TaskWraith workspace after tool policy allows it.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        }
      }
    },
    {
      name: 'workspace_search',
      description: 'Search the active workspace with ripgrep and return structured JSON matches.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          globs: { type: 'array', items: { type: 'string' } },
          contextLines: { type: 'number' },
          maxResults: { type: 'number' }
        },
        required: ['query']
      }
    },
    {
      name: 'web_search',
      description:
        'Search the web for current online information and return top result titles and URLs. Read-only network access.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' }
        },
        required: ['query']
      }
    },
    {
      name: 'web_fetch',
      description: 'Fetch the text contents of an absolute http(s) URL. Read-only network access.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The absolute http(s) URL to fetch.' }
        },
        required: ['url']
      }
    },
    {
      name: 'apply_patch',
      description: 'Validate or apply a git-style unified diff patch in the active workspace.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          patch: { type: 'string' },
          dryRun: { type: 'boolean' },
          check: { type: 'boolean' }
        },
        required: ['patch']
      }
    },
    {
      name: 'git_status',
      description: 'Return structured git status for the active workspace.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'git_diff',
      description: 'Return git diff output for the active workspace.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          cached: { type: 'boolean' },
          staged: { type: 'boolean' },
          stat: { type: 'boolean' },
          paths: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    {
      name: 'git_stage',
      description: 'Stage selected files or all changes in the active workspace.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          patch: {
            type: 'string',
            description: 'Optional unified diff to stage with git apply --cached.'
          },
          all: { type: 'boolean' },
          update: { type: 'boolean' }
        }
      }
    },
    {
      name: 'git_commit',
      description: 'Create a git commit in the active workspace with the supplied message.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message']
      }
    },
    {
      name: 'run_task',
      description:
        'Run a known project task such as test, typecheck, lint, or build and return structured output.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number' }
        },
        required: ['task']
      }
    },
    {
      name: 'test_result_summary',
      description: 'Summarize test failures from supplied output or a durable run id.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          output: { type: 'string' },
          runId: { type: 'string' }
        }
      }
    },
    {
      name: 'list_subthreads',
      description:
        'List lifecycle-aware sub-threads under the active parent chat, including readiness to read results.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          parentChatId: { type: 'string' },
          includeArchived: { type: 'boolean' },
          includePrompt: { type: 'boolean' }
        }
      }
    },
    {
      name: 'read_subthread_result',
      description:
        'Read lifecycle, final result, transcript slices, and/or run events from a sub-thread owned by the active parent chat.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          subThreadId: { type: 'string' },
          depth: {
            type: 'string',
            enum: ['summary', 'final-only', 'full', 'events-only'],
            description:
              'Controls payload size. summary omits full text; final-only returns lifecycle + latest result; full includes runs/messages/events; events-only returns lifecycle + run events.'
          },
          includeRuns: { type: 'boolean' },
          includeMessages: { type: 'boolean' },
          includeEvents: { type: 'boolean' },
          messageLimit: { type: 'number' },
          eventLimit: { type: 'number' }
        },
        required: ['subThreadId']
      }
    },
    {
      name: 'cancel_subthread',
      description: 'Cancel an active run in a sub-thread owned by the active parent chat.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          subThreadId: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['subThreadId']
      }
    },
    {
      name: 'workspace_symbols',
      description:
        'Find likely source symbols in the active workspace using a fast regex fallback.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          maxResults: { type: 'number' }
        }
      }
    },
    {
      name: 'browser_open',
      description: 'Open a URL or workspace file in the dedicated MCP browser window.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          path: { type: 'string' },
          show: { type: 'boolean' },
          width: { type: 'number' },
          height: { type: 'number' }
        }
      }
    },
    {
      name: 'browser_click',
      description: 'Click in the dedicated MCP browser window by selector or viewport coordinates.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' }
        }
      }
    },
    {
      name: 'browser_screenshot',
      description:
        'Capture the dedicated MCP browser window and optionally write the PNG inside the workspace.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional workspace-relative output path.' }
        }
      }
    },
    {
      name: 'attached_window_capture',
      description:
        "Capture one frame of the macOS window the user attached via the TaskWraith picker. Returns a PNG (as an image content block) plus optional local Vision OCR. Fails fast with a structured error when no window is attached — never enumerates windows the user hasn't picked. The user must click the Attach button (or use the hotkey) first; you cannot initiate the pick.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          include_ocr: {
            type: 'boolean',
            description:
              'Run local Vision OCR on the captured frame and return text + bounding boxes. Default true.'
          },
          max_dimension_px: {
            type: 'number',
            description:
              'Cap the longer side of the returned image to this many pixels (preserves aspect ratio). Default 1600.'
          }
        }
      }
    },
    {
      name: 'attached_window_status',
      description:
        'Return whether a user-picked window is currently attached, and if so just its title/bundle/application name. Carries no pixel data and no enumeration of other windows; safe to poll. Auto-approved (no modal); the user already chose to share this metadata when they picked the window.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    // Phase M1 — Appwatch MVP. Continuous low-fps capture of the attached
    // window into a small ring buffer. `appwatch_start` spins up the stream,
    // `appwatch_latest_frame` pulls the most recent frame without per-call
    // ScreenCaptureKit overhead. Memory-budgeted at 350 MB (the daemon
    // refuses oversized configs). Auto-stops after 60s with no
    // `appwatch_latest_frame` pulls.
    //
    // Defaults: 5fps × 8s buffer × 1280px (longer side). Agents should
    // think hard before raising any of these — buffer footprint scales
    // quadratically with `max_dimension_px`.
    //
    // All four require a previously-attached window (user clicked Attach
    // or invoked the hotkey). None of them initiate a pick.
    {
      name: 'appwatch_start',
      description:
        'Start a continuous low-fps capture stream of the attached window into a daemon-side ring buffer. Returns the resolved config. Idempotent: second call with same handle returns the existing config without restarting. Refuses if the configured buffer would exceed 350 MB — reduce fps/bufferSeconds/maxDimensionPx and retry. The user must have already attached a window via the picker; you cannot initiate the pick.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          fps: {
            type: 'number',
            description: 'Frames per second (1-30). Default 5.'
          },
          buffer_seconds: {
            type: 'number',
            description:
              'How many seconds of frames to keep in the daemon-side ring (1-60). Default 8 (= 40-frame ring at 5fps).'
          },
          max_dimension_px: {
            type: 'number',
            description:
              'Cap the longer side of each frame to this many pixels (240-4096). Default 1280. Smaller values keep the buffer well under the 350 MB cap.'
          }
        }
      }
    },
    {
      name: 'appwatch_stop',
      description:
        'Stop the Appwatch stream for the attached window and free the ring buffer. Safe to call when no stream is running. Detaching the window (or the daemon idling for 60s without a frame pull) also stops the stream.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'appwatch_status',
      description:
        'Read-only Appwatch stream status — fps, bufferSeconds, current frameCount, oldest/newest frame timestamps, memory footprint, idle-timeout pull clock. Does NOT bump the idle-timeout clock; safe to poll from a UI. Returns `streaming: false` when no stream is running or when the daemon auto-stopped on idle timeout.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'appwatch_latest_frame',
      description:
        'Return the most recent frame from the Appwatch ring buffer as a PNG (image content block). Bumps the idle-timeout pull clock so an active agent loop keeps the stream alive. Fails fast if `appwatch_start` has not been called for the current handle. Returns `hasFrame: false` when the stream is up but no frame has landed yet (first frame typically arrives within ~200 ms). For batch/since retrieval use `appwatch_frames`.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'appwatch_frames',
      description:
        'Return a chronological batch of recent Appwatch frames from the attached-window ring buffer. Input `{ since?: string, count?: number, format?: "jpeg" | "png", include_ocr?: boolean, includeOCR?: boolean }`; defaults to count=5 and jpeg, clamps count to 1..20, and clamps to 1..5 when OCR is enabled. Returns structured metadata with hasFrames, returned, nextSince, availability timestamps, and one image content block per returned frame.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description:
              'Fractional-second ISO timestamp from a prior nextSince. Returns frames captured after this timestamp.'
          },
          count: {
            type: 'number',
            description:
              'Number of frames to return. Default 5; clamped to 1..20, or 1..5 with OCR.'
          },
          format: {
            type: 'string',
            enum: ['jpeg', 'png'],
            description: 'Image block format. Default jpeg.'
          },
          include_ocr: {
            type: 'boolean',
            description:
              'Run local Vision OCR for each returned frame. Default false; limits count to 5.'
          },
          includeOCR: {
            type: 'boolean',
            description: 'Camel-case alias for include_ocr.'
          }
        }
      }
    },
    {
      name: 'browser_console',
      description:
        'Return recent MCP browser console messages, or app renderer console messages with target=app/all.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['browser', 'app', 'all'] },
          clear: { type: 'boolean' },
          limit: { type: 'number' }
        }
      }
    },
    {
      name: 'approval_status',
      description:
        'Return approval policies, workspace grants, and recent approval ledger records. ' +
        'By default the query is scoped to the current run+chat (derived from the calling ' +
        'agent context) so the agent sees only approvals relevant to its own work. Pass ' +
        "`all: true` to widen the query to ALL of the calling agent's provider's approvals " +
        'across every run+chat — useful for auditing or surfacing historical approvals. ' +
        'Explicit `runId` / `chatId` always override scope inference, regardless of `all`.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: selectableProviderIds(),
            description: "Optional provider override. Defaults to the calling agent's provider."
          },
          service: {
            type: 'string',
            enum: [
              'shellCommands',
              'fileChanges',
              'mcpTools',
              'subThreadDelegation',
              'canvasInteraction',
              'crossThreadRead',
              'canvasEval'
            ],
            description: 'Filter to one approval-service kind. Omit to return all kinds.'
          },
          approvalId: {
            type: 'string',
            description: 'Filter to a specific approval record by id.'
          },
          runId: {
            type: 'string',
            description:
              'Filter to a specific run id. Always honored; setting this overrides the ' +
              'default current-run scope. Pairs with `all: true` to keep `runId` narrow while ' +
              'widening the chat scope.'
          },
          chatId: {
            type: 'string',
            description:
              'Filter to a specific chat id. Always honored; setting this overrides the ' +
              'default current-chat scope.'
          },
          statuses: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by ledger record status (e.g. `pending` / `approved`).'
          },
          scopes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by approval scope (e.g. `oneshot` / `chat` / `workspace`).'
          },
          includeExpired: {
            type: 'boolean',
            description: 'Include expired records. Defaults to false.'
          },
          includePreview: {
            type: 'boolean',
            description:
              'Include the payload preview (command excerpts, diffs, tool args). Defaults to ' +
              "false to keep the response compact; set true when you need the approval's content."
          },
          all: {
            type: 'boolean',
            description:
              "Widen the query past the calling agent's current run+chat. When true, the " +
              'default run/chat narrowing is skipped — every approval matching the other ' +
              'filters across all runs and chats is returned (still scoped to the calling ' +
              "agent's provider unless `provider` is overridden). Defaults to false."
          },
          limit: {
            type: 'number',
            description: 'Max records to return. Defaults to 25, capped at 200.'
          }
        }
      }
    },
    {
      name: 'provider_auth_status',
      description:
        'Return sanitized provider authentication status. Tokens and secrets are never included.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: { provider: { type: 'string', enum: selectableProviderIds() } }
      }
    },
    {
      name: 'provider_usage_status',
      description:
        'Return a coarse quota-band view of the requested provider (or all providers when ' +
        'omitted) so the calling agent can self-throttle or pick a lighter model when a ' +
        'window is near exhaustion. Per window, the response carries a `band` value of one of ' +
        "`'low' | 'medium' | 'high' | 'critical' | 'unknown'` (computed from `usedPercent`) " +
        'plus the underlying percent, the window label, and `resetAt` if known. No raw ' +
        'credentials or account-identifying detail. This is intentionally COARSE — finer ' +
        'numeric usage telemetry beyond the band is deferred to a future tool to keep this ' +
        'one cheap and stable across provider snapshot-shape changes.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: selectableProviderIds(),
            description: 'Optional provider to filter to. Omit to return all four providers.'
          }
        }
      }
    },
    {
      name: 'run_timeline',
      description: 'Return structured durable run timeline events for a run.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          limit: { type: 'number' },
          includeEvents: { type: 'boolean' },
          includePayload: { type: 'boolean' }
        }
      }
    },
    {
      name: 'raw_provider_events',
      description: 'Return raw provider durable events for parser debugging.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          chatId: { type: 'string' },
          provider: { type: 'string', enum: selectableProviderIds() },
          includeArtifacts: { type: 'boolean' },
          limit: { type: 'number' }
        }
      }
    },
    {
      name: 'open_workspace_file',
      description: 'Open or reveal a workspace file on the host.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, reveal: { type: 'boolean' } },
        required: ['path']
      }
    },
    {
      name: 'creative_app_status',
      description:
        'Return the supported creative app adapters, install hints, attached-window match, transports, risk tiers, and limitations. Read-only discovery; does not enumerate windows beyond the user-attached window.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          appId: {
            type: 'string',
            enum: ['final-cut-pro', 'logic-pro', 'blender'],
            description: 'Optional creative app id to filter.'
          }
        }
      }
    },
    {
      name: 'creative_app_capabilities',
      description:
        'Return detailed TaskWraith creative app adapter capabilities for Final Cut Pro, Logic Pro, and Blender, including safe transports, approval risk tiers, prompts, and known limitations.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          appId: {
            type: 'string',
            enum: ['final-cut-pro', 'logic-pro', 'blender'],
            description: 'Optional creative app id to filter.'
          }
        }
      }
    },
    {
      name: 'creative_project_snapshot',
      description:
        'Read a workspace creative project or interchange file and return a bounded, read-only structural snapshot. Supports FCPXML, MusicXML, MIDI headers, Blender file hints, and package metadata without mutating source projects.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path to a creative project file or package directory.'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'creative_timeline_validate',
      description:
        'Validate a workspace FCPXML timeline/interchange document with lightweight read-only checks: root/version, structural counts, duplicate ids, unresolved refs, and truncation warnings. Does not import or mutate Final Cut Pro projects.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path to an FCPXML document.'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'creative_timeline_ir',
      description:
        'Parse a workspace FCPXML document into the compact TaskWraith timeline IR for preview, diff, and plan workflows. Does not import or mutate Final Cut Pro projects.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path to an FCPXML document.'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'creative_timeline_diff',
      description:
        'Compare an original FCPXML and a drafted FCPXML into a read-only timeline diff plan, affected-resource summary, and JSON sidecar payload. Does not import or mutate Final Cut Pro projects.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          beforePath: {
            type: 'string',
            description: 'Workspace-relative path to the original FCPXML document.'
          },
          afterPath: {
            type: 'string',
            description: 'Workspace-relative path to the drafted FCPXML document.'
          }
        },
        required: ['beforePath', 'afterPath']
      }
    },
    {
      name: 'creative_timeline_import',
      description:
        'Write a timeline IR to .fcpxml and hand it to Final Cut Pro via NSWorkspace.open. REQUIRES USER APPROVAL — a modal will surface in TaskWraith asking the user to approve the import before dispatch. Returns { refused, reason } if the user rejects, or { dispatched: true, filePath, daemonResult } on approval.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          ir: {
            type: 'object',
            description:
              'FCPXML timeline IR. Top-level shape: { version?: "1.13", resources?: { formats: [{id, name, frameDuration, width, height, colorSpace?}], assets: [{id, name, src, duration, format?, hasVideo?, hasAudio?}], effects: [{id, name, uid}] }, projects: [{name, eventName?, sequence: { format, duration, tcStart?, tcFormat?, spine: [...] }}] }. Spine items: { index, type, name?, ref?, offset, start?, duration, lane?, format?, markers: [], captions: [] }. For asset-clip items use audioRole/videoRole (the DTD does NOT accept generic `role` on asset-clip). For audio-only assets set hasAudio: "1", hasVideo: "0". For title items pass either the canonical rich shape { textRuns: [{text, styleRef}], textStyleDefs: [{id, font, fontSize, fontFace, fontColor, alignment}], titleParams: [{name, value}] } OR the forgiving flat shape { text, font, fontSize, alignment, position, fontColor } — the writer auto-coerces flat to canonical. Times are rational strings like "5s", "1001/30000s", "3000/2400s"; the writer canonicalises to the format frame-duration denominator on emit.',
            properties: {
              version: { type: 'string' },
              resources: { type: 'object' },
              projects: { type: 'array' }
            }
          },
          bundleId: {
            type: 'string',
            description:
              'Optional target app bundle id. Default com.apple.FinalCut. Must be one of the declared creative-app bundle ids.'
          }
        },
        required: ['ir']
      }
    },
    {
      name: 'open_in_ide',
      description:
        "Open a file in the user's editor of choice via NSWorkspace. Optional `ide` arg picks one of: vscode, vscode-insiders, cursor, zed, sublime-text, xcode, bbedit, nova, textmate, intellij-idea, webstorm, pycharm, goland, clion, rustrover, rider, rubymine, phpstorm, datagrip, android-studio. When omitted, picks the first running editor → first installed → vscode fallback. No approval needed (focus-change only).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or absolute path to the file.' },
          ide: {
            type: 'string',
            description: 'Optional editor id (see description) or bundle id.'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'open_in_ide_at_position',
      description:
        "Open a file at a specific line and column via the editor's CLI shim (code -g, cursor -g, subl, xed -l, JetBrains --line --column, etc). Falls back to a plain NSWorkspace open when the editor's CLI is not on PATH or doesn't support positional args (the fallback response includes a cliMissing flag the agent can surface to the user).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'integer', description: 'Target line, 1-indexed.' },
          column: { type: 'integer', description: 'Target column, 1-indexed. Optional.' },
          ide: { type: 'string', description: 'Optional editor id or bundle id.' }
        },
        required: ['path', 'line']
      }
    },
    {
      name: 'reveal_in_finder',
      description:
        'Reveal a file in macOS Finder with the file selected. Wraps NSWorkspace.selectFile.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    },
    {
      name: 'ide_app_status',
      description:
        'Snapshot of every recognised editor / IDE with installedHint + runningHint per entry. Cheap; backed by a 3-second cache.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'ide_app_capabilities',
      description:
        'Same shape as ide_app_status plus per-editor notes + a positionalArgsSample showing how `open_in_ide_at_position` would invoke that editor. Useful when the agent wants to preview the CLI command before dispatch.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'list_running_ides',
      description:
        'Return just the editors currently running (filter of ide_app_status). Use when handing off to "whatever\'s open right now".',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'creative_midi_dispatch',
      description:
        'Send a MIDI event through TaskWraith\'s virtual "TaskWraith" Core MIDI source. Logic Pro (or any MIDI receiver) can route this source as input. Supported eventTypes: note_on, note_off, cc, program_change, transport_play, transport_stop. Requires user approval; approval is cacheable per eventType for the session.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          eventType: {
            type: 'string',
            description:
              'One of: note_on, note_off, cc, program_change, transport_play, transport_stop'
          },
          channel: {
            type: 'integer',
            description: 'MIDI channel 0-15 (required for note_on/off, cc, program_change)'
          },
          note: { type: 'integer', description: 'Note number 0-127 (note_on, note_off)' },
          velocity: {
            type: 'integer',
            description: 'Velocity 0-127 (note_on; often 0 for note_off)'
          },
          controller: { type: 'integer', description: 'CC controller number 0-127 (cc)' },
          value: { type: 'integer', description: 'CC value 0-127 (cc)' },
          program: { type: 'integer', description: 'Program number 0-127 (program_change)' }
        },
        required: ['eventType']
      }
    },
    {
      name: 'creative_blender_python',
      description:
        'Run a Python script inside `Blender --background --python` in a per-invocation sandbox tempdir. Two modes: { className, params } picks a curated class (render-still, import-obj, export-gltf); { pythonSource, inputBlendPath? } runs raw Python. REQUIRES USER APPROVAL — modal shows the Python source. Named classes are cacheable for session; raw always prompts. Default timeout 30s.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          className: {
            type: 'string',
            description: 'Optional named class id (render-still, import-obj, export-gltf).'
          },
          params: {
            type: 'object',
            description: 'Param map for the named class.'
          },
          pythonSource: {
            type: 'string',
            description: 'Raw Python source. Mutually exclusive with className.'
          },
          inputBlendPath: {
            type: 'string',
            description:
              'Optional absolute path to a .blend file Blender should open before running the script.'
          }
        }
      }
    },
    {
      name: 'creative_applescript_dispatch',
      description:
        'Dispatch an AppleScript class against Final Cut Pro or Logic Pro. Two modes: pass { className, params } to invoke a curated named class (fcp.open-project, fcp.set-playhead, fcp.export-current, logic.open-project, logic.set-tempo) or pass { source } for raw AppleScript. REQUIRES USER APPROVAL — a modal will surface with the script source. Named classes can be approved-and-cached for the session; raw scripts always prompt.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          className: {
            type: 'string',
            description:
              'Optional named class id (one of: fcp.open-project, fcp.set-playhead, fcp.export-current, logic.open-project, logic.set-tempo). Mutually exclusive with `source`.'
          },
          params: {
            type: 'object',
            description:
              'Param map for the named class. Each class declares its own param spec; see the class library or the approval modal preview for shape.'
          },
          source: {
            type: 'string',
            description:
              'Raw AppleScript source. Mutually exclusive with `className`. Always prompts on each invocation; never cached.'
          }
        }
      }
    },
    {
      name: 'create_handoff_card',
      description: 'Create an TaskWraith handoff card from the active chat/run.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          finalPrompt: { type: 'string' },
          recommendedProvider: { type: 'string', enum: selectableProviderIds() },
          selectedFiles: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    {
      name: 'switch_auth_profile',
      description: 'Switch the active provider auth profile. Currently supports Gemini profiles.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: { provider: { type: 'string' }, profileId: { type: 'string' } }
      }
    },
    {
      name: 'agent_delegation_role',
      description:
        'Store a preferred delegation role/instructions for a provider on the active chat.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: selectableProviderIds() },
          role: { type: 'string' },
          instructions: { type: 'string' }
        },
        required: ['provider', 'role']
      }
    },
    {
      name: 'ensemble_yield',
      description:
        'In Ensemble Mode, explicitly pass this participant turn to the next participant. Optional reason explains why; optional target names the participant/provider that should speak next.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          target: { type: 'string' }
        }
      }
    },
    {
      name: 'ensemble_send',
      description:
        'In Ensemble Mode, send a visible participant-to-participant note into the main transcript. Use this for agent-to-agent side communication that should become context for later participants. The message is not private or hidden from the user.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description:
              'Target participant role/provider/model alias, or an array of aliases. Use list_ensemble_participants if unsure.'
          },
          message: {
            type: 'string',
            description: 'The note to show visibly in the transcript.'
          },
          reason: {
            type: 'string',
            description: 'Optional reason for the side message.'
          }
        },
        required: ['to', 'message']
      }
    },
    {
      name: 'ensemble_fanout',
      description:
        'In Ensemble Mode, ask multiple participants to run in parallel lanes and wait for their results. Default mode is read_only: targets must resolve to read-only participants. mode=locked_writers requires TASKWRAITH_CONCURRENT_WRITE_LANES and routes writer-capable lanes through workspace write locks.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional participant aliases. Omit to fan out to all eligible peers except the caller.'
          },
          prompt: {
            type: 'string',
            description:
              'Focused prompt for the fan-out lanes. Include exactly what each target should investigate or do.'
          },
          reason: {
            type: 'string',
            description: 'Optional reason shown in the transcript.'
          },
          mode: {
            type: 'string',
            enum: ['read_only', 'locked_writers'],
            description:
              'Default read_only. locked_writers is feature-gated and allows writer-capable targets only when write-locking is enabled.'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'ensemble_bossman_control',
      description:
        'In Ensemble Mode, allows the assigned Bossman participant to make event-bound orchestration decisions: skip/stop participants, replace a participant after provider health checks, reorder the remaining queue with cooldown, queue a follow-up, or pause/complete a managed Work Session. Non-Bossman callers and stale round/run/participant ids are rejected and audited.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'skip_participant',
              'stop_round',
              'replace_participant',
              'reorder_remaining',
              'queue_followup',
              'pause_work_session',
              'complete_work_session'
            ]
          },
          roundId: {
            type: 'string',
            description: 'Optional stale-command guard. Must match the active Ensemble round id.'
          },
          targetParticipantId: {
            type: 'string',
            description:
              'Required for skip/replace unless targetRunId identifies the active target.'
          },
          targetRunId: {
            type: 'string',
            description: 'Optional stale-run guard for active participant or fan-out lane skips.'
          },
          participantIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'For reorder_remaining: pending participant ids in desired priority order. Omitted pending participants keep their relative order after these ids.'
          },
          prompt: {
            type: 'string',
            description: 'For queue_followup: prompt for the next queued round.'
          },
          reason: {
            type: 'string',
            description: 'Human-readable rationale recorded into the transcript/status metadata.'
          },
          replacement: {
            type: 'object',
            properties: {
              provider: { type: 'string', enum: selectableProviderIds() },
              role: { type: 'string' },
              instructions: { type: 'string' },
              model: { type: 'string' },
              permissionPresetId: { type: 'string' },
              reasoningEffort: { type: 'string' },
              fastModeEnabled: { type: 'boolean' },
              thinkingEnabled: { type: 'boolean' }
            },
            required: ['provider']
          }
        },
        required: ['action']
      }
    },
    {
      name: 'list_ensemble_participants',
      description:
        'In Ensemble Mode, list the current participants, providers, roles, models, and per-round statuses for the active round.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'schedule_wakeup',
      description:
        'In Ensemble Mode, pause this participant and schedule it to resume later in the same active round. Active participant runs only; unavailable from parallel fan-out lanes. Provide wakeAt (ISO), delayMs, or delaySeconds. Maximum delay 7 days — schedule sequential wakeups (one now, another on resume) for longer horizons.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          wakeAt: {
            type: 'string',
            description: 'ISO timestamp for when this participant should resume.'
          },
          delayMs: {
            type: 'number',
            description: 'Delay before resuming, in milliseconds.'
          },
          delaySeconds: {
            type: 'number',
            description: 'Delay before resuming, in seconds.'
          },
          reason: {
            type: 'string',
            description: 'Optional reason shown in the transcript and resume prompt.'
          },
          cancelOnUserInput: {
            type: 'boolean',
            description:
              'Default true. When true, a new user message cancels this pending wake before the next user round starts.'
          }
        }
      }
    },
    {
      name: 'cancel_wakeup',
      description:
        'Cancel this participant’s pending wakeup in the active Ensemble round. Omit wakeupId to cancel all own pending wakeups for the round.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          wakeupId: { type: 'string' }
        }
      }
    },
    {
      // QMOD (1.0.3) — ask the user a question and pause the agent's
      // turn until they respond. Returns the user's answer as the tool
      // result so the agent can continue. CRITICAL fix for plan mode:
      // before this tool existed, agents asking questions in plan
      // mode would emit the question as text, the user wouldn't see
      // it as actionable, the agent would time out / exit plan mode.
      //
      // Usage pattern: agent prefers this tool over inline "What
      // should I…?" prose whenever they need a clarification before
      // proceeding. Renderer shows a modal card with the question +
      // option buttons + free-text fallback ("Other"). Universally
      // auto-allowed because the renderer modal IS the gate.
      name: 'ask_user_question',
      description:
        'Pause the turn and surface a question to the user via a modal card. ' +
        'Use this whenever you need the user to make a decision before you can proceed — for plan-mode clarifications, design choices, or any other branch point that depends on user intent. ' +
        'Preferable to emitting the question as inline prose because the user gets a focused modal with buttons instead of having to type back. ' +
        'Provide 2-4 concise option strings if the answer is multiple-choice; otherwise omit `options` to ask a free-text question. ' +
        '`context` may carry a sub-paragraph of explanation shown beneath the question. ' +
        'Returns the user\'s `answer` string. If the user dismissed the modal (cancelled), the tool returns `cancelled: true` and the agent should treat that as "skip this step".',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            maxLength: 600,
            description: 'The question to ask the user. One sentence; ends with a question mark.'
          },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: { type: 'string', maxLength: 96 },
            description:
              'Optional 2-4 pre-set answer choices. The renderer renders each as a button. Omit for free-text questions.'
          },
          context: {
            type: 'string',
            maxLength: 240,
            description:
              'Optional sub-paragraph (≤ 240 chars) of additional context shown beneath the question. Use for "why I\'m asking" framing.'
          }
        },
        required: ['question']
      }
    },
    {
      name: 'goal_read',
      description:
        'Read the active TaskWraith thread goal. A goal is the persistent objective and stopping condition for this chat; it is separate from todo_write checklists.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'goal_update',
      description:
        'Update the lifecycle status of the existing active TaskWraith goal without changing its objective. Use this for status transitions only; the user owns setting, replacing, and clearing the objective.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'paused', 'blocked', 'completed'],
            description: 'New lifecycle status for the existing active goal.'
          },
          reason: {
            type: 'string',
            maxLength: 800,
            description: 'Optional concise reason, blocker detail, or completion summary.'
          }
        },
        required: ['status']
      }
    },
    {
      name: 'update_goal',
      description:
        'Compatibility alias for goal_update. Grok Build official /goal requires an update_goal tool in the session toolset; this updates only the lifecycle status of the existing active TaskWraith goal.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'paused', 'blocked', 'completed'],
            description: 'New lifecycle status for the existing active goal.'
          },
          reason: {
            type: 'string',
            maxLength: 800,
            description: 'Optional concise reason, blocker detail, or completion summary.'
          }
        },
        required: ['status']
      }
    },
    {
      name: 'goal_complete',
      description:
        'Mark the existing active TaskWraith goal completed. Only call this when the objective has genuinely been achieved and verified; todo_write completion alone is not enough.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            maxLength: 800,
            description: 'Optional concise completion summary or verification evidence.'
          }
        }
      }
    },
    {
      name: 'goal_blocked',
      description:
        'Mark the existing active TaskWraith goal blocked when meaningful progress requires user input or an external state change. Include a concrete blocker reason.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            maxLength: 800,
            description: 'Concrete blocker reason.'
          }
        },
        required: ['reason']
      }
    },
    {
      // 1.4.2 — structured goal-step / todo checklist for every provider.
      // Renderer parses `todos[]` into a checklist card and pins the
      // current `in_progress` (or first `pending`) step in the live
      // activity viewport while a run is streaming.
      name: 'todo_write',
      description:
        'Publish or update a structured goal-step checklist for the current run. ' +
        'Use this to break multi-step work into trackable items the user can follow in the transcript. ' +
        'Each todo needs a stable `id`, human-readable `content`, and `status` (`pending`, `in_progress`, `completed`, or `cancelled`). ' +
        'Keep exactly one item `in_progress` when actively working. ' +
        'Set `merge: true` to patch existing steps by `id`; omit or set `merge: false` to replace the whole list. ' +
        'Prefer this over prose bullet lists when executing a plan with 3+ steps.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          merge: {
            type: 'boolean',
            description:
              'When true, merge `todos` into the existing checklist by `id`. When false/omitted, replace the whole list.'
          },
          todos: {
            type: 'array',
            description: 'Goal steps for this run.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable identifier for this step.' },
                content: { type: 'string', description: 'Short human-readable step label.' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: 'Current state of the step.'
                }
              },
              required: ['id', 'content', 'status']
            }
          }
        },
        required: ['todos']
      }
    },
    {
      // Phase F3: agent-driven sub-thread delegation. Spawns a
      // sub-thread under the active parent thread, optionally on a
      // different provider, and (fire-and-forget) dispatches a run
      // with the delegation prompt. Returns immediately with the
      // sub-thread id; the result auto-propagates back to the
      // parent transcript as an untrusted tool-result message on
      // sub-thread completion via the F2 back-propagation path (when
      // returnResult=true).
      //
      // The parent provider should mention to the user that they
      // delegated, so the user knows to watch the sub-thread in the
      // sidebar or wait for the returned sub-thread result card.
      name: 'delegate_to_subthread',
      description:
        'Send a prompt to a sub-thread on a chosen TaskWraith provider (gemini/codex/claude/kimi). ' +
        'By DEFAULT this spawns a NEW context-isolated sub-thread under the active parent — the returned tool_result includes the sub-thread id. ' +
        'To CONTINUE an existing completed/returned sub-thread (back-and-forth conversation with the same delegated agent), pass that id as `subThreadId` on subsequent calls. ' +
        'Recall is opt-in: omitting `subThreadId` always spawns fresh. ' +
        'Recall while the sub-thread is still running is rejected in v1; use list_subthreads/read_subthread_result to inspect lifecycle and retry after completion. ' +
        "When returnResult is true, the sub-thread's final assistant message auto-propagates back to the parent transcript on completion as untrusted child-agent output, not system authority.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: selectableProviderIds(),
            description: 'Which TaskWraith provider should run the sub-thread.'
          },
          prompt: {
            type: 'string',
            description:
              "Delegation prompt. For a fresh sub-thread it primes the first turn; for a recall (when subThreadId is set) it's appended as the next user turn in the existing sub-thread."
          },
          returnResult: {
            type: 'boolean',
            description:
              "When true, the sub-thread's final assistant message returns to the parent transcript as untrusted child-agent output on completion."
          },
          subThreadId: {
            type: 'string',
            description:
              'Optional. If set, RECALL the existing sub-thread with this id instead of spawning a new one. The id MUST come from an earlier delegate_to_subthread tool_result issued from THIS parent chat, target the same provider, be unarchived, not currently running, and have a resumable provider session — otherwise the call errors. Use this for back-and-forth with a single delegated sub-agent across multiple turns.'
          }
        },
        required: ['provider', 'prompt']
      }
    },
    {
      name: 'ensemble_continue',
      description:
        'In an active Ensemble Work Session, queue one follow-up round, mark the session complete, or pause it as blocked. ' +
        'Choose acceptanceStatus deliberately: use `complete` only when the task is fully done and verified — every required tool call (edits, run_task checks, tests) actually ran and succeeded. ' +
        'Use `blocked` only when you are genuinely stuck and need user input to proceed. ' +
        'Use `inProgress` (with nextPrompt) to queue another round and keep working. ' +
        'What is NOT blocked: a test you can fix is not a block — fix it and continue; a recoverable error (retryable failure, missing file you can create, tool you can call differently) is not a block — keep working. ' +
        'Does not bypass participant permissions; each queued round still uses the normal approval and permission path.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          nextPrompt: {
            type: 'string',
            description: 'Required when acceptanceStatus is inProgress.'
          },
          target: {
            type: 'string',
            description:
              'Optional participant alias to include in the follow-up prompt for normal @mention routing.'
          },
          reason: { type: 'string' },
          acceptanceStatus: {
            type: 'string',
            enum: ['inProgress', 'complete', 'blocked']
          }
        }
      }
    },
    {
      name: 'scout_brief',
      description:
        'Emit a structured brief from a parallel fan-out lane. The next serial writer/synthesizer receives the collected briefs in its prompt. Returns an error outside an active fan-out lane.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          findings: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          blockers: { type: 'array', items: { type: 'string' } },
          recommendations: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['findings', 'confidence']
      }
    },
    {
      name: 'blackboard_post',
      description:
        'Post a durable shared-memory entry for the Ensemble. Use for agreed facts, decisions, risks, do-not-repeat notes, or concise session notes. Do not use this for conversational side messages; use ensemble_send instead.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          category: {
            type: 'string',
            enum: ['decision', 'fact', 'risk', 'do-not-repeat', 'note']
          },
          scope: {
            type: 'string',
            enum: ['round', 'session', 'chat']
          }
        },
        required: ['key', 'value']
      }
    },
    {
      name: 'canvas_open',
      description:
        'Open a TaskWraith Canvas: a sandboxed preview of a running app the agent can inspect. Driver "web" (default) loads an http(s) `url` (typically a local dev server, e.g. http://localhost:3000) and supports the full structured surface (snapshot/inspect/click/fill/eval). Driver "device" launches an app by `bundleId` in a booted iOS Simulator (optionally installing a built `appPath` first; optional `udid`, default the booted sim) and is SCREENSHOT-ONLY — only canvas_screenshot/canvas_close apply; the DOM verbs return an error. Returns a canvasId used by every other canvas_* tool. Gated; the web driver blocks file://, link-local and cloud-metadata addresses.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          driver: { type: 'string', enum: ['web', 'device'] },
          url: { type: 'string', description: 'web driver: the http(s) URL to preview.' },
          bundleId: {
            type: 'string',
            description: 'device driver: the app bundle id to launch, e.g. "com.example.App".'
          },
          appPath: {
            type: 'string',
            description: 'device driver: absolute path to a built .app to install before launch.'
          },
          udid: {
            type: 'string',
            description: 'device driver: target simulator UDID (default: the booted simulator).'
          },
          width: { type: 'number' },
          height: { type: 'number' },
          originAllowlist: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    {
      name: 'canvas_list',
      description:
        'List currently open Canvas sessions (canvasId, driver, url, status). Read-only; carries no pixels.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'canvas_status',
      description:
        'Return metadata for one Canvas session (status, url, viewport). Read-only; carries no pixels.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: { canvasId: { type: 'string' } },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_snapshot',
      description:
        'Return the Canvas as a structured element tree with stable refs (e.g. ref "e7"), roles, accessible names, text and bounding boxes. PREFER this over a screenshot for reading structure/text — it is cheaper and deterministic, and its refs are how you target canvas_inspect.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: { canvasId: { type: 'string' } },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_screenshot',
      description:
        'Capture the Canvas as a PNG (image content block) plus dimensions. Use as a VISUAL SUPPLEMENT to canvas_snapshot — e.g. to check layout/spacing/colour you cannot read from the tree. Gated (pixel egress).',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: { canvasId: { type: 'string' } },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_inspect',
      description:
        'Inspect ONE element — by `ref` (from canvas_snapshot) or CSS `selector` — returning tag, role, text, bounding box and computed styles. BEST tool for verifying exact colours, fonts, spacing and dimensions (more accurate than a screenshot). Read-only.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          styles: { type: 'array', items: { type: 'string' } }
        },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_network',
      description:
        'List network requests observed by the Canvas (url, method, status). Pass `requestId` for a single entry; `filter:"failed"` for 4xx/5xx and errors. Read-only.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          requestId: { type: 'number' },
          filter: { type: 'string', enum: ['all', 'failed'] }
        },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_console',
      description:
        'Return Canvas console output (log/info/warn/error). `level:"error"` or `"warn"` filters. Read-only.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          level: { type: 'string', enum: ['all', 'warn', 'error'] },
          lines: { type: 'number' }
        },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_resize',
      description:
        'Resize the Canvas viewport to test responsive layouts. Use `preset` (mobile 375x812 / tablet 768x1024 / desktop 1280x800) or explicit width/height. Gated.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop'] },
          width: { type: 'number' },
          height: { type: 'number' }
        },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_click',
      description:
        'Click an element in the Canvas by `ref` (from canvas_snapshot — preferred), CSS `selector`, or `x`/`y` coordinates. Dispatches a realistic mouse interaction. Gated; denied under read-only. Re-run canvas_snapshot afterwards to observe the result.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' }
        },
        required: ['canvasId']
      }
    },
    {
      name: 'canvas_fill',
      description:
        'Set the value of an input/textarea/select in the Canvas by `ref` or CSS `selector`, firing input+change events (React-compatible). Gated; denied under read-only. The typed value is never recorded in the audit log.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          value: { type: 'string' }
        },
        required: ['canvasId', 'value']
      }
    },
    {
      name: 'canvas_annotate',
      description:
        'Overlay numbered Set-of-Mark boxes on the Canvas to flag elements for the human (agent→human redlines). Each mark targets a `ref` or explicit `bbox` [x,y,w,h] with a `label` and optional `severity` (info/warn/error). Persisted and visible in a subsequent canvas_screenshot. Gated.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          marks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                bbox: { type: 'array', items: { type: 'number' } },
                label: { type: 'string' },
                severity: { type: 'string', enum: ['info', 'warn', 'error'] }
              },
              required: ['label']
            }
          }
        },
        required: ['canvasId', 'marks']
      }
    },
    {
      name: 'canvas_eval',
      description:
        'Run arbitrary JavaScript in the Canvas page and return its (size-capped) completion value. The MOST powerful canvas verb: it executes agent-supplied code in the previewed app (RCE). PREFER canvas_snapshot / canvas_inspect / canvas_click / canvas_fill — reach for eval only when a structured tool cannot express the check. Signed-elevated: it PROMPTS EVERY CALL (never auto-allowed by a grant, preset, or session-YOLO) and is denied under read-only; the human approving sees the exact script. The page network egress is best-effort cut while the script runs. The script text and its result are never written to the audit log.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          script: { type: 'string', description: 'JavaScript evaluated in the page global scope.' }
        },
        required: ['canvasId', 'script']
      }
    },
    {
      name: 'canvas_close',
      description: 'Close a Canvas session and free its preview window. Gated.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: { canvasId: { type: 'string' } },
        required: ['canvasId']
      }
    },
    {
      name: 'tw_recall_find',
      description:
        'Find past runs on OTHER threads to answer "how far did <provider> get with <task> <when> in <workspace>?". Resolves deliberately-vague references (a provider alias, an approximate time like "yesterday ~6pm", a workspace name, a task description) to a ranked, bounded set of candidate runs. Returns the host interpretation, a verdict (one|many|none), and STRUCTURAL candidate metadata only — never prompt or transcript text. Call tw_recall_read with a candidate runId to read how far it got. Read-only. Discovery in your OWN workspace is allowed; other workspaces require user approval. On "many" disambiguate from the metadata or ask the user; on "none" say you could not find it — never guess.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description:
              'Which agent ran it, e.g. "ollama" / "the local model", "claude", "codex" / "gpt". Optional.'
          },
          workspace: {
            type: 'string',
            description: 'Workspace name or id the run belonged to. Optional.'
          },
          timeApprox: {
            type: 'string',
            description:
              'Approximate time, e.g. "yesterday ~6pm", "this morning", "last 3 days". Resolved in the host timezone. Optional.'
          },
          taskQuery: {
            type: 'string',
            description: 'A few words describing the task, e.g. "auth refactor". Optional.'
          },
          freeText: {
            type: 'string',
            description: "The user's raw phrasing, used as extra topic signal. Optional."
          },
          limit: { type: 'number', description: 'Max candidates to return (capped at 10).' }
        }
      }
    },
    {
      name: 'tw_recall_read',
      description:
        'Read how far a specific past run got: a durable timeline rollup (start/end, status, tool/diff counts), its final assistant message, and structured plan/todo progress. Take the runId from a tw_recall_find candidate. Read-only; reading a run in a DIFFERENT workspace than the current chat requires user approval. Fails closed if the run forensic record was deleted. Every served record carries a citation token — quote it (in the form provided) so the claim is verifiable.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          runId: {
            type: 'string',
            description: 'The run to read (from a tw_recall_find candidate).'
          },
          depth: {
            type: 'string',
            enum: ['summary', 'full'],
            description:
              'summary (default) = rollup + final message + plan progress; full = also a bounded slice of timeline events.'
          }
        },
        required: ['runId']
      }
    },
    {
      name: 'tw_recall_read_events',
      description:
        "Read the raw tool/diff/timeline event bodies for a specific past run, truncated. Use only when tw_recall_read's summary is not enough. Take the runId from a tw_recall_find candidate. Read-only; cross-workspace reads require approval. Long transcripts are compacted on disk, so older detail may be summarized rather than verbatim.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          runId: {
            type: 'string',
            description: 'The run to read (from a tw_recall_find candidate).'
          },
          kind: {
            type: 'string',
            description: 'Optional event-kind filter, e.g. "tool", "diff", "final_message".'
          },
          limit: { type: 'number', description: 'Max events to return (bounded).' }
        },
        required: ['runId']
      }
    }
  ]
  return orderTaskWraithMcpToolDefinitions(definitions)
}

function orderTaskWraithMcpToolDefinitions(
  definitions: TaskWraithMcpToolDefinition[]
): TaskWraithMcpToolDefinition[] {
  const byName = new Map<TaskWraithMcpToolName, TaskWraithMcpToolDefinition>()
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`Duplicate TaskWraith MCP tool definition: ${definition.name}`)
    }
    byName.set(definition.name, definition)
  }
  const registryNames = new Set<TaskWraithMcpToolName>(TASKWRAITH_MCP_TOOLS)
  const extras = definitions
    .map((definition) => definition.name)
    .filter((name) => !registryNames.has(name))
  if (extras.length > 0) {
    throw new Error(`Unknown TaskWraith MCP tool definition(s): ${extras.join(', ')}`)
  }
  return TASKWRAITH_MCP_TOOLS.map((name) => {
    const definition = byName.get(name)
    if (!definition) {
      throw new Error(`Missing TaskWraith MCP tool definition: ${name}`)
    }
    return definition
  })
}
