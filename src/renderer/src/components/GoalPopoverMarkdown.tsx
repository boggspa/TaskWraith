import { StableMarkdownBlock } from './StableMarkdownBlock'

interface GoalPopoverMarkdownProps {
  content: string
  className?: string
}

/** Safe, compact Markdown presentation for an active goal and its blocker. */
export function GoalPopoverMarkdown({ content, className }: GoalPopoverMarkdownProps) {
  return (
    <div className={['composer-goal-markdown', className].filter(Boolean).join(' ')}>
      <StableMarkdownBlock raw={content} />
    </div>
  )
}
