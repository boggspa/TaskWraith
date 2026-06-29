import type { OllamaModelInfo } from './OllamaProvider'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

export function ollamaUsesCompactToolSchemas(
  modelId?: string | null,
  modelInfo?: OllamaModelInfo | null
): boolean {
  return resolveOllamaModelFamily(modelId || '', modelInfo) === 'gpt_oss_20b'
}

export function ollamaOneToolAtATime(
  modelId?: string | null,
  modelInfo?: OllamaModelInfo | null
): boolean {
  return resolveOllamaModelFamily(modelId || '', modelInfo) === 'gpt_oss_20b'
}

export function ollamaPrefersJsonToolProtocol(
  modelId?: string | null,
  modelInfo?: OllamaModelInfo | null
): boolean {
  return resolveOllamaModelFamily(modelId || '', modelInfo) !== 'gpt_oss_20b'
}

export function ollamaGptOssFewShotTrajectories(): string[] {
  return [
    'Example A — search then read: workspace_search({"query":"resolveContextBudget","path":"src","maxResults":20,"contextLines":1}) → read_file({"path":"src/main/PromptComposition.ts","startLine":1,"endLine":80}) → answer with findings.',
    'Example B — patch one file: workspace_search({"query":"resolveOllamaToolRequests","path":"src/main/ollama","maxResults":10,"contextLines":1}) → read_file({"path":"src/main/ollama/OllamaProvider.ts"}) → replace({"path":"...","old_string":"...","new_string":"...","intent":"adjust local tool-call parsing"})',
    'Example C — complex task checklist: todo_write({"merge":true,"todos":[{"id":"explore","content":"Explore workspace","status":"in_progress"},{"id":"patch","content":"Apply scoped patch","status":"pending"}]}) → workspace_search(...) → read_file(...) → replace(...)',
    'Example D — no tool needed: answer directly in prose when the user question is conceptual and does not require workspace facts.'
  ]
}
