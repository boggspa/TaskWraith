// Canonical TaskWraith MCP tool catalog — RE-EXPORT SHIM.
//
// The pure catalog (tool-name list + derived type/const, the tool-name
// canonicalizer, and the media-editing set) was lifted verbatim to
// src/shared/taskWraithMcpCatalog.ts so src/shared consumers (canonicalToolCoalesce)
// can import it WITHOUT a shared -> main runtime edge — scripts/architecture-guard.cjs
// keeps `sharedUpwardRuntimeEdges` at []. This module re-exports the shared catalog
// unchanged, so every existing src/main and src/renderer importer of
// './TaskWraithMcpTools' keeps working; main -> shared is a permitted downward import.
export {
  TASKWRAITH_MCP_TOOLS,
  TASKWRAITH_MCP_TOOL_LIST,
  canonicalTaskWraithToolName,
  isPortableEnsembleControlToolName,
  normalizePortableEnsembleControlArguments,
  MESH_SCENE_MCP_TOOL_NAMES,
  SIMULATOR_MCP_TOOL_NAMES,
  SIMULATOR_MUTATING_MCP_TOOL_NAMES,
  MEDIA_EDITING_TOOL_NAMES,
  MEDIA_EDITING_TOOLS
} from '../shared/taskWraithMcpCatalog'
export type {
  TaskWraithMcpToolName,
  MediaEditingToolName,
  MeshSceneMcpToolName,
  SimulatorMcpToolName,
  SimulatorMutatingMcpToolName
} from '../shared/taskWraithMcpCatalog'
