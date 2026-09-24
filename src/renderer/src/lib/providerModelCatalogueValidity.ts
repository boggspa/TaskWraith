/**
 * Whether a provider's model catalogue may be used to reject a stored model id.
 *
 * Some picker catalogues are state-backed rather than static. Pi's is the live
 * case: `getProviderModelOptions('pi')` is `agentModelsByProvider.pi || []`,
 * fetched over IPC at startup and again on a key mutation, and main returns only
 * the upstreams that actually have a stored key. So `[]` is reached three
 * different ways -- the fetch has not resolved yet, the fetch threw (the catch
 * seeds a fallback for codex/claude/kimi/ollama and deliberately not for Pi),
 * or there are genuinely no keys.
 *
 * None of those three means "the id this chat stored is wrong", but an exact
 * membership test says exactly that, and every caller answers a no by
 * substituting `getDefaultModelForProvider`. On Pi that default is the one row
 * flagged `isDefault` -- `deepseek/deepseek-v4-flash`. The result is a thread
 * whose stored model is `cerebras/qwen-3.8-27b` showing, and DISPATCHING,
 * DeepSeek: `resolveDispatchRequest` and the queued-job path both coerce
 * through the same predicate, so the substituted model is the one that actually
 * answers the turn.
 *
 * An empty catalogue is therefore treated as unknown, and the stored id stands.
 * Nothing is weakened by that: main holds the authoritative catalogue and
 * validates the dispatch anyway, whereas the substitute could not run either --
 * a profile with no Pi keys cannot reach DeepSeek any more than it can reach
 * Cerebras. A POPULATED catalogue still rejects an id it does not contain, which
 * is the case the check was written for (a retired or foreign model id).
 */
export function providerModelCatalogueAccepts(
  catalogue: readonly { id: string }[],
  modelId: string
): boolean {
  if (catalogue.length === 0) return true
  return catalogue.some((model) => model.id === modelId)
}
