import { describe, expect, it } from 'vitest'
import type { ToolDiffSummary } from '../main/store/types'
import {
  collectShellWriteEvidence,
  shellCommandTextFromInput,
  shellWriteEvidenceDiffSummary
} from './shellCommandEditEvidence'

const noPatch = (): ToolDiffSummary | undefined => undefined

describe('shellCommandTextFromInput', () => {
  it('reads the broker command string', () => {
    expect(shellCommandTextFromInput({ command: 'ls -la' })).toBe('ls -la')
  })

  it('reads cmd and script spellings', () => {
    expect(shellCommandTextFromInput({ cmd: 'pwd' })).toBe('pwd')
    expect(shellCommandTextFromInput({ script: 'pwd' })).toBe('pwd')
  })

  it('joins argv-array commands', () => {
    expect(shellCommandTextFromInput({ command: ['bash', '-lc', 'ls'] })).toBe('bash -lc ls')
  })

  it('returns empty for missing or non-string commands', () => {
    expect(shellCommandTextFromInput({})).toBe('')
    expect(shellCommandTextFromInput({ command: 42 })).toBe('')
  })
})

describe('collectShellWriteEvidence — heredoc content writes', () => {
  it('counts a cat > path heredoc', () => {
    const command = "cat > src/app.py << 'EOF'\nline1\nline2\nline3\nEOF"
    expect(collectShellWriteEvidence(command)).toEqual([
      { kind: 'content', path: 'src/app.py', lines: 3, append: false }
    ])
  })

  it('marks >> heredocs as appends', () => {
    const command = 'cat >> notes.md <<EOF\na\nb\nEOF'
    expect(collectShellWriteEvidence(command)).toEqual([
      { kind: 'content', path: 'notes.md', lines: 2, append: true }
    ])
  })

  it('finds the redirect when it follows the heredoc operator', () => {
    const command = 'cat << EOF > out.txt\nx\nEOF'
    expect(collectShellWriteEvidence(command)).toEqual([
      { kind: 'content', path: 'out.txt', lines: 1, append: false }
    ])
  })

  it('reads tee targets, including append mode', () => {
    expect(collectShellWriteEvidence("tee src/config.json << 'JSON'\n{}\nJSON")).toEqual([
      { kind: 'content', path: 'src/config.json', lines: 1, append: false }
    ])
    expect(collectShellWriteEvidence('tee -a log.txt <<EOF\nentry\nEOF')).toEqual([
      { kind: 'content', path: 'log.txt', lines: 1, append: true }
    ])
  })

  it('unquotes redirect targets with spaces', () => {
    const command = 'cat > "my file.txt" <<EOF\nx\nEOF'
    expect(collectShellWriteEvidence(command)).toEqual([
      { kind: 'content', path: 'my file.txt', lines: 1, append: false }
    ])
  })

  it('yields nothing for a heredoc piped into an interpreter', () => {
    expect(collectShellWriteEvidence("python3 - <<'EOF'\nprint(1)\nEOF")).toEqual([])
  })

  it('never scans heredoc bodies for further evidence', () => {
    const command = "cat > run.sh <<'EOF'\nsed -i 's/a/b/' other.txt\necho hi > another.txt\nEOF"
    expect(collectShellWriteEvidence(command)).toEqual([
      { kind: 'content', path: 'run.sh', lines: 2, append: false }
    ])
  })
})

describe('collectShellWriteEvidence — patch appliers', () => {
  const patchBody = 'diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n-old\n+new'

  it('captures a git apply heredoc body', () => {
    const command = `git apply <<'EOF'\n${patchBody}\nEOF`
    expect(collectShellWriteEvidence(command)).toEqual([{ kind: 'patch', body: patchBody }])
  })

  it('captures apply_patch and patch -p heredocs', () => {
    expect(collectShellWriteEvidence(`apply_patch <<EOF\n${patchBody}\nEOF`)).toEqual([
      { kind: 'patch', body: patchBody }
    ])
    expect(collectShellWriteEvidence(`patch -p1 <<EOF\n${patchBody}\nEOF`)).toEqual([
      { kind: 'patch', body: patchBody }
    ])
  })

  it('does not treat a mention of apply_patch as an invocation', () => {
    expect(collectShellWriteEvidence('rg apply_patch src/')).toEqual([])
  })
})

describe('collectShellWriteEvidence — inline redirects', () => {
  it('counts echo lines', () => {
    expect(collectShellWriteEvidence("echo 'export FOO=1' >> ~/.zshrc")).toEqual([
      { kind: 'content', path: '~/.zshrc', lines: 1, append: true }
    ])
  })

  it('counts printf escape-sequence lines', () => {
    expect(collectShellWriteEvidence("printf 'a\\nb\\n' > f.txt")).toEqual([
      { kind: 'content', path: 'f.txt', lines: 2, append: false }
    ])
  })

  it('counts a herestring as one line', () => {
    expect(collectShellWriteEvidence('cat <<< "one line" > f.txt')).toEqual([
      { kind: 'content', path: 'f.txt', lines: 1, append: false }
    ])
  })

  it('records generic redirects as uncounted writes', () => {
    expect(collectShellWriteEvidence('sort data.txt > sorted.txt')).toEqual([
      { kind: 'content', path: 'sorted.txt', lines: undefined, append: false }
    ])
  })

  it('ignores fd redirects and /dev targets', () => {
    expect(collectShellWriteEvidence('cmd 2> err.log')).toEqual([])
    expect(collectShellWriteEvidence('cmd > /dev/null 2>&1')).toEqual([])
  })
})

describe('collectShellWriteEvidence — in-place editors', () => {
  it('names sed -i targets', () => {
    expect(collectShellWriteEvidence("sed -i 's/a/b/' src/main.rs")).toEqual([
      { kind: 'inplace', paths: ['src/main.rs'] }
    ])
  })

  it('handles the BSD sed -i backup-suffix form', () => {
    expect(collectShellWriteEvidence("sed -i '' 's/a/b/g' Makefile")).toEqual([
      { kind: 'inplace', paths: ['Makefile'] }
    ])
  })

  it('ignores sed without -i', () => {
    expect(collectShellWriteEvidence("sed 's/a/b/' src/main.rs")).toEqual([])
  })
})

describe('collectShellWriteEvidence — compound commands', () => {
  it('collects every write across && chains and later lines', () => {
    const command = "mkdir -p src && cat > src/a.ts <<'EOF'\nx\ny\nEOF\necho hi > b.txt"
    expect(collectShellWriteEvidence(command)).toEqual([
      { kind: 'content', path: 'src/a.ts', lines: 2, append: false },
      { kind: 'content', path: 'b.txt', lines: 1, append: false }
    ])
  })

  it('keeps evidence out of read-only commands', () => {
    expect(collectShellWriteEvidence('git diff HEAD~1')).toEqual([])
    expect(collectShellWriteEvidence('ls -la && rg TODO src/')).toEqual([])
  })
})

describe('shellWriteEvidenceDiffSummary', () => {
  it('sums heredoc content into an estimated content summary', () => {
    const command = "cat > src/app.py << 'EOF'\nline1\nline2\nline3\nEOF"
    expect(shellWriteEvidenceDiffSummary(command, noPatch)).toEqual({
      additions: 3,
      deletions: 0,
      files: [{ path: 'src/app.py', status: 'modified', additions: 3, deletions: 0 }],
      source: 'content',
      confidence: 'estimated'
    })
  })

  it('routes patch bodies through the supplied parser and stays estimated', () => {
    const command = "git apply <<'EOF'\ndiff --git a/f b/f\n+new\n-old\nEOF"
    const parsed: ToolDiffSummary = {
      additions: 4,
      deletions: 2,
      files: [{ path: 'f.ts', status: 'modified', additions: 4, deletions: 2 }],
      source: 'patch_preview',
      confidence: 'exact'
    }
    expect(shellWriteEvidenceDiffSummary(command, () => parsed)).toEqual({
      additions: 4,
      deletions: 2,
      files: [{ path: 'f.ts', status: 'modified', additions: 4, deletions: 2 }],
      source: 'patch_preview',
      confidence: 'estimated'
    })
  })

  it('returns undefined when the only evidence is uncounted', () => {
    expect(shellWriteEvidenceDiffSummary('sort data.txt > sorted.txt', noPatch)).toBeUndefined()
    expect(shellWriteEvidenceDiffSummary("sed -i 's/a/b/' src/main.rs", noPatch)).toBeUndefined()
  })

  it('returns undefined for commands with no write evidence at all', () => {
    expect(shellWriteEvidenceDiffSummary('git diff HEAD~1', noPatch)).toBeUndefined()
  })

  it('lists uncounted paths alongside counted totals', () => {
    const command = "cat > a.txt <<EOF\nx\nEOF\nsed -i 's/a/b/' src/main.rs"
    expect(shellWriteEvidenceDiffSummary(command, noPatch)).toEqual({
      additions: 1,
      deletions: 0,
      files: [
        { path: 'a.txt', status: 'modified', additions: 1, deletions: 0 },
        { path: 'src/main.rs', status: 'modified' }
      ],
      source: 'content',
      confidence: 'estimated'
    })
  })

  it('ignores a patch body the parser rejects', () => {
    const command = 'git apply <<EOF\nnot a diff\nEOF'
    expect(shellWriteEvidenceDiffSummary(command, noPatch)).toBeUndefined()
  })
})
