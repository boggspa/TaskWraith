import { AgentIdentityContext } from './AgentIdentityContext'
import { StableMarkdownBlock } from './StableMarkdownBlock'
import { splitMarkdownIntoBlocks } from '../lib/MarkdownBlockSplit'
import type { ChatRecord } from '../../../main/store/types'

interface MarkdownMessageProps {
  content: string
  /** Chat used to look up subagent identities for `[@Name](agent://id)` chips. */
  chat?: ChatRecord
}

/**
 * MarkdownMessage — orchestrator for streaming-friendly markdown.
 *
 * Phase L1a refactor. The renderer is now block-aware:
 *
 *   1. We split `content` into stable blocks + an optional tail via
 *      `splitMarkdownIntoBlocks` (pure string scan, no mdast).
 *   2. Each stable block goes through `StableMarkdownBlock`, keyed by
 *      `<index>-<content-hash>`. That subtree is `React.memo`'d on `raw`,
 *      so a parent re-render driven by `assistant_message_delta` only
 *      diffs the tail.
 *   3. The tail is rendered through the same memoised component, keyed
 *      by `tail-<stable.length>` (the "tail" prefix avoids colliding
 *      with the numeric stable-index keys). The key changes ONLY when a
 *      block commits to the stable prefix (stable.length grows), so
 *      across the deltas that grow a single block the tail re-renders
 *      IN PLACE instead of unmount/remount. That lets a streaming code
 *      fence reuse its CodeMirror EditorView (a cheap per-delta doc
 *      transaction) instead of destroying + recreating the whole view
 *      every keystroke. The stable prefix survives unchanged.
 *      (Was `tail-<content-hash>`, which rolled every keystroke and
 *      forced a full remount of the tail subtree per delta.)
 *
 * Position-aware keys (the `<index>-` prefix) fix a class of bugs where
 * two blocks within the SAME message share identical raw content —
 * most prominently the `\n\n---\n\n` horizontal-rule separators K2 (b)
 * injects between Codex item transitions. With pure content-hash keys,
 * a message containing two `---` blocks (e.g. body + summary + extra
 * agentMessage in one turn) produced two siblings with the SAME React
 * key; React's prod reconciler silently merged them, leaving the
 * rendered transcript missing chars / words and shuffled — the
 * "Route 120-second MCP I'm rer..." style garbling observed on Codex.
 * Including the position guarantees siblings always have distinct keys
 * regardless of content collisions. The `React.memo` short-circuit on
 * `raw` is preserved because position is stable for stable blocks
 * across append-only re-renders.
 *
 * The output HTML is byte-for-byte identical to the pre-L1a renderer
 * for any complete (non-streaming) message — the existing snapshot
 * tests verify that. The win is paid for entirely by the streaming
 * path; for a 5K-token reply we go from N parses per delta (where N
 * is total token count) to roughly 1 parse per delta (just the tail).
 *
 * The `AgentIdentityContext.Provider` wraps the whole markdown subtree
 * so `<AgentMention>` chips in any block can look up the chat's
 * identity registry without prop drilling.
 */
export function MarkdownMessage({ content, chat }: MarkdownMessageProps) {
  const { stable, tail } = splitMarkdownIntoBlocks(content)
  return (
    <AgentIdentityContext.Provider value={chat}>
      <div className="message-markdown message-markdown-pro">
        {stable.map((block, index) => (
          <StableMarkdownBlock key={`${index}-${block.id}`} raw={block.raw} />
        ))}
        {tail ? <StableMarkdownBlock key={`tail-${stable.length}`} raw={tail.raw} /> : null}
      </div>
    </AgentIdentityContext.Provider>
  )
}
