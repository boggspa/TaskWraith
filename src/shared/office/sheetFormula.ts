/**
 * Small spreadsheet formula engine for the Sheet editor. Covers the basic
 * Excel/Sheets surface: cell refs (A1, $B$2), ranges (A1:C3), arithmetic
 * (+ - * / ^ %), text concatenation (&), comparisons, and a core function
 * set (SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, ROUND, ABS, SQRT, CONCAT,
 * LEN, UPPER, LOWER, TRIM). Errors surface Excel-style: #DIV/0!, #VALUE!,
 * #REF!, #NAME?, #CYCLE!, #ERROR!.
 *
 * Evaluation is memoized per grid with cycle detection; results are display
 * strings so the UI and the xlsx cached-value writer share one code path.
 */

export type FormulaScalar = number | string | boolean

export class FormulaError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** 0-based column index → 'A', 'Z', 'AA'… */
export function columnLabel(index: number): string {
  let label = ''
  let cursor = index
  while (cursor >= 0) {
    label = String.fromCharCode(65 + (cursor % 26)) + label
    cursor = Math.floor(cursor / 26) - 1
  }
  return label
}

/** 'A' → 0, 'AA' → 26. Returns -1 for invalid labels. */
export function columnIndex(label: string): number {
  let value = 0
  for (const char of label.toUpperCase()) {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) return -1
    value = value * 26 + (code - 64)
  }
  return value - 1
}

export interface CellAddress {
  row: number
  col: number
}

export function parseCellRef(ref: string): CellAddress | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim())
  if (!match) return null
  const col = columnIndex(match[1])
  const row = Number.parseInt(match[2], 10) - 1
  if (col < 0 || row < 0) return null
  return { row, col }
}

export function cellRefLabel(address: CellAddress): string {
  return `${columnLabel(address.col)}${address.row + 1}`
}

// --- Tokenizer -------------------------------------------------------------

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (char === ' ' || char === '\t') {
      index += 1
      continue
    }
    if (/[0-9.]/.test(char)) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(input.slice(index))
      if (!match) throw new FormulaError('#VALUE!')
      tokens.push({ type: 'number', value: Number.parseFloat(match[0]) })
      index += match[0].length
      continue
    }
    if (char === '"') {
      let value = ''
      index += 1
      while (index < input.length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            value += '"'
            index += 2
            continue
          }
          break
        }
        value += input[index]
        index += 1
      }
      if (input[index] !== '"') throw new FormulaError('#VALUE!')
      index += 1
      tokens.push({ type: 'string', value })
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[$A-Za-z_][$A-Za-z0-9_.]*/.exec(input.slice(index))
      if (!match) throw new FormulaError('#VALUE!')
      tokens.push({ type: 'ident', value: match[0] })
      index += match[0].length
      continue
    }
    if (char === '(') {
      tokens.push({ type: 'lparen' })
      index += 1
      continue
    }
    if (char === ')') {
      tokens.push({ type: 'rparen' })
      index += 1
      continue
    }
    if (char === ',') {
      tokens.push({ type: 'comma' })
      index += 1
      continue
    }
    const twoChar = input.slice(index, index + 2)
    if (twoChar === '<=' || twoChar === '>=' || twoChar === '<>') {
      tokens.push({ type: 'op', value: twoChar })
      index += 2
      continue
    }
    if ('+-*/^&%=<>:'.includes(char)) {
      tokens.push({ type: 'op', value: char })
      index += 1
      continue
    }
    throw new FormulaError('#VALUE!')
  }
  return tokens
}

// --- Parser (recursive descent → AST) ---------------------------------------

type AstNode =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'ref'; row: number; col: number }
  | { type: 'range'; start: CellAddress; end: CellAddress }
  | { type: 'call'; name: string; args: AstNode[] }
  | { type: 'unary'; op: string; operand: AstNode }
  | { type: 'binary'; op: string; left: AstNode; right: AstNode }

class Parser {
  private readonly tokens: Token[]
  private index = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index]
    this.index += 1
    return token
  }

  parse(): AstNode {
    const node = this.parseComparison()
    if (this.index < this.tokens.length) throw new FormulaError('#VALUE!')
    return node
  }

  private parseComparison(): AstNode {
    let left = this.parseConcat()
    while (true) {
      const token = this.peek()
      if (token?.type === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(token.value)) {
        this.next()
        left = { type: 'binary', op: token.value, left, right: this.parseConcat() }
      } else {
        return left
      }
    }
  }

  private parseConcat(): AstNode {
    let left = this.parseAdditive()
    while (true) {
      const token = this.peek()
      if (token?.type === 'op' && token.value === '&') {
        this.next()
        left = { type: 'binary', op: '&', left, right: this.parseAdditive() }
      } else {
        return left
      }
    }
  }

  private parseAdditive(): AstNode {
    let left = this.parseMultiplicative()
    while (true) {
      const token = this.peek()
      if (token?.type === 'op' && (token.value === '+' || token.value === '-')) {
        this.next()
        left = { type: 'binary', op: token.value, left, right: this.parseMultiplicative() }
      } else {
        return left
      }
    }
  }

  private parseMultiplicative(): AstNode {
    let left = this.parseUnary()
    while (true) {
      const token = this.peek()
      if (token?.type === 'op' && (token.value === '*' || token.value === '/')) {
        this.next()
        left = { type: 'binary', op: token.value, left, right: this.parseUnary() }
      } else {
        return left
      }
    }
  }

  private parseUnary(): AstNode {
    const token = this.peek()
    if (token?.type === 'op' && (token.value === '-' || token.value === '+')) {
      this.next()
      return { type: 'unary', op: token.value, operand: this.parseUnary() }
    }
    return this.parsePower()
  }

  private parsePower(): AstNode {
    let left = this.parsePostfix()
    const token = this.peek()
    if (token?.type === 'op' && token.value === '^') {
      this.next()
      // Right-associative.
      left = { type: 'binary', op: '^', left, right: this.parseUnary() }
    }
    return left
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary()
    while (true) {
      const token = this.peek()
      if (token?.type === 'op' && token.value === '%') {
        this.next()
        node = { type: 'binary', op: '/', left: node, right: { type: 'number', value: 100 } }
      } else {
        return node
      }
    }
  }

  private parsePrimary(): AstNode {
    const token = this.next()
    if (!token) throw new FormulaError('#VALUE!')
    if (token.type === 'number') return { type: 'number', value: token.value }
    if (token.type === 'string') return { type: 'string', value: token.value }
    if (token.type === 'lparen') {
      const node = this.parseComparison()
      const closing = this.next()
      if (!closing || closing.type !== 'rparen') throw new FormulaError('#VALUE!')
      return node
    }
    if (token.type === 'ident') {
      const upper = token.value.toUpperCase()
      if (upper === 'TRUE') return { type: 'boolean', value: true }
      if (upper === 'FALSE') return { type: 'boolean', value: false }
      const following = this.peek()
      if (following?.type === 'lparen') {
        this.next()
        const args: AstNode[] = []
        if (this.peek()?.type !== 'rparen') {
          while (true) {
            args.push(this.parseComparison())
            const separator = this.peek()
            if (separator?.type === 'comma') {
              this.next()
              continue
            }
            break
          }
        }
        const closing = this.next()
        if (!closing || closing.type !== 'rparen') throw new FormulaError('#VALUE!')
        return { type: 'call', name: upper, args }
      }
      const ref = parseCellRef(token.value)
      if (ref) {
        const rangeSeparator = this.peek()
        if (rangeSeparator?.type === 'op' && rangeSeparator.value === ':') {
          this.next()
          const endToken = this.next()
          if (endToken?.type !== 'ident') throw new FormulaError('#REF!')
          const endRef = parseCellRef(endToken.value)
          if (!endRef) throw new FormulaError('#REF!')
          return { type: 'range', start: ref, end: endRef }
        }
        return { type: 'ref', row: ref.row, col: ref.col }
      }
      throw new FormulaError('#NAME?')
    }
    throw new FormulaError('#VALUE!')
  }
}

// --- Evaluator ---------------------------------------------------------------

const toNumber = (value: FormulaScalar): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  const trimmed = value.trim()
  if (trimmed === '') return 0
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) throw new FormulaError('#VALUE!')
  return parsed
}

const toText = (value: FormulaScalar): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return formatNumber(value)
}

const isBlankLiteral = (raw: string | undefined): boolean => raw === undefined || raw === ''

export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const fixed = value.toPrecision(12)
  return String(Number.parseFloat(fixed))
}

interface EvaluationContext {
  rows: string[][]
  memo: Map<string, FormulaScalar>
  visiting: Set<string>
}

function literalScalar(raw: string): FormulaScalar {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (trimmed === 'TRUE') return true
  if (trimmed === 'FALSE') return false
  const numeric = Number(trimmed)
  if (
    trimmed !== '' &&
    Number.isFinite(numeric) &&
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?%?$/.test(trimmed)
  ) {
    if (trimmed.endsWith('%')) return Number(trimmed.slice(0, -1)) / 100
    return numeric
  }
  return raw
}

function cellScalar(context: EvaluationContext, row: number, col: number): FormulaScalar {
  const key = `${row}:${col}`
  const cached = context.memo.get(key)
  if (cached !== undefined) return cached
  const raw = context.rows[row]?.[col] ?? ''
  if (!raw.startsWith('=')) {
    const value = literalScalar(raw)
    context.memo.set(key, value)
    return value
  }
  if (context.visiting.has(key)) throw new FormulaError('#CYCLE!')
  context.visiting.add(key)
  try {
    const ast = new Parser(tokenize(raw.slice(1))).parse()
    const value = evaluateNode(context, ast)
    context.memo.set(key, value)
    return value
  } finally {
    context.visiting.delete(key)
  }
}

function rangeScalars(
  context: EvaluationContext,
  start: CellAddress,
  end: CellAddress
): { value: FormulaScalar; blank: boolean }[] {
  const rowStart = Math.min(start.row, end.row)
  const rowEnd = Math.max(start.row, end.row)
  const colStart = Math.min(start.col, end.col)
  const colEnd = Math.max(start.col, end.col)
  if ((rowEnd - rowStart + 1) * (colEnd - colStart + 1) > 100_000) throw new FormulaError('#REF!')
  const values: { value: FormulaScalar; blank: boolean }[] = []
  for (let row = rowStart; row <= rowEnd; row += 1) {
    for (let col = colStart; col <= colEnd; col += 1) {
      values.push({
        value: cellScalar(context, row, col),
        blank: isBlankLiteral(context.rows[row]?.[col])
      })
    }
  }
  return values
}

function flattenArgs(
  context: EvaluationContext,
  args: AstNode[]
): { value: FormulaScalar; blank: boolean }[] {
  const flat: { value: FormulaScalar; blank: boolean }[] = []
  for (const arg of args) {
    if (arg.type === 'range') flat.push(...rangeScalars(context, arg.start, arg.end))
    else flat.push({ value: evaluateNode(context, arg), blank: false })
  }
  return flat
}

function evaluateCall(context: EvaluationContext, name: string, args: AstNode[]): FormulaScalar {
  switch (name) {
    case 'SUM':
      return flattenArgs(context, args)
        .filter((entry) => !entry.blank)
        .reduce((total, entry) => total + coerceNumericEntry(entry.value), 0)
    case 'AVERAGE': {
      const numbers = flattenArgs(context, args)
        .filter((entry) => !entry.blank && typeof entry.value !== 'string')
        .map((entry) => toNumber(entry.value))
      if (numbers.length === 0) throw new FormulaError('#DIV/0!')
      return numbers.reduce((total, value) => total + value, 0) / numbers.length
    }
    case 'MIN':
    case 'MAX': {
      const numbers = flattenArgs(context, args)
        .filter((entry) => !entry.blank && typeof entry.value === 'number')
        .map((entry) => entry.value as number)
      if (numbers.length === 0) return 0
      return name === 'MIN' ? Math.min(...numbers) : Math.max(...numbers)
    }
    case 'COUNT':
      return flattenArgs(context, args).filter(
        (entry) => !entry.blank && typeof entry.value === 'number'
      ).length
    case 'COUNTA':
      return flattenArgs(context, args).filter((entry) => !entry.blank).length
    case 'IF': {
      if (args.length < 2 || args.length > 3) throw new FormulaError('#VALUE!')
      const condition = evaluateNode(context, args[0])
      const truthy = typeof condition === 'number' ? condition !== 0 : condition === true
      if (truthy) return evaluateNode(context, args[1])
      return args.length === 3 ? evaluateNode(context, args[2]) : false
    }
    case 'ROUND': {
      if (args.length < 1 || args.length > 2) throw new FormulaError('#VALUE!')
      const value = toNumber(evaluateNode(context, args[0]))
      const digits = args.length === 2 ? Math.trunc(toNumber(evaluateNode(context, args[1]))) : 0
      const factor = 10 ** digits
      return Math.round((value + Number.EPSILON) * factor) / factor
    }
    case 'ABS':
      if (args.length !== 1) throw new FormulaError('#VALUE!')
      return Math.abs(toNumber(evaluateNode(context, args[0])))
    case 'SQRT': {
      if (args.length !== 1) throw new FormulaError('#VALUE!')
      const value = toNumber(evaluateNode(context, args[0]))
      if (value < 0) throw new FormulaError('#VALUE!')
      return Math.sqrt(value)
    }
    case 'CONCAT':
    case 'CONCATENATE':
      return flattenArgs(context, args)
        .map((entry) => (entry.blank ? '' : toText(entry.value)))
        .join('')
    case 'LEN':
      if (args.length !== 1) throw new FormulaError('#VALUE!')
      return toText(evaluateNode(context, args[0])).length
    case 'UPPER':
      if (args.length !== 1) throw new FormulaError('#VALUE!')
      return toText(evaluateNode(context, args[0])).toUpperCase()
    case 'LOWER':
      if (args.length !== 1) throw new FormulaError('#VALUE!')
      return toText(evaluateNode(context, args[0])).toLowerCase()
    case 'TRIM':
      if (args.length !== 1) throw new FormulaError('#VALUE!')
      return toText(evaluateNode(context, args[0])).trim().replace(/ {2,}/g, ' ')
    default:
      throw new FormulaError('#NAME?')
  }
}

/** Range aggregation skips text (Excel SUM semantics); direct args coerce. */
const coerceNumericEntry = (value: FormulaScalar): number => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return 0
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return toNumber(value)
}

function evaluateNode(context: EvaluationContext, node: AstNode): FormulaScalar {
  switch (node.type) {
    case 'number':
      return node.value
    case 'string':
      return node.value
    case 'boolean':
      return node.value
    case 'ref':
      return cellScalar(context, node.row, node.col)
    case 'range':
      throw new FormulaError('#VALUE!')
    case 'call':
      return evaluateCall(context, node.name, node.args)
    case 'unary': {
      const value = toNumber(evaluateNode(context, node.operand))
      return node.op === '-' ? -value : value
    }
    case 'binary': {
      const { op } = node
      if (op === '&') {
        return toText(evaluateNode(context, node.left)) + toText(evaluateNode(context, node.right))
      }
      if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
        const left = evaluateNode(context, node.left)
        const right = evaluateNode(context, node.right)
        return compareScalars(left, right, op)
      }
      const left = toNumber(evaluateNode(context, node.left))
      const right = toNumber(evaluateNode(context, node.right))
      switch (op) {
        case '+':
          return left + right
        case '-':
          return left - right
        case '*':
          return left * right
        case '/':
          if (right === 0) throw new FormulaError('#DIV/0!')
          return left / right
        case '^':
          return left ** right
        default:
          throw new FormulaError('#VALUE!')
      }
    }
  }
}

function compareScalars(left: FormulaScalar, right: FormulaScalar, op: string): boolean {
  let result: number
  if (typeof left === 'string' || typeof right === 'string') {
    const leftText = toText(left).toLowerCase()
    const rightText = toText(right).toLowerCase()
    result = leftText < rightText ? -1 : leftText > rightText ? 1 : 0
  } else {
    const leftNumber = toNumber(left)
    const rightNumber = toNumber(right)
    result = leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  switch (op) {
    case '=':
      return result === 0
    case '<>':
      return result !== 0
    case '<':
      return result < 0
    case '>':
      return result > 0
    case '<=':
      return result <= 0
    default:
      return result >= 0
  }
}

export interface SheetEvaluation {
  /** Display strings, same dimensions as the input rows. */
  display: string[][]
  /** True when the matching cell held a formula that failed. */
  errors: Map<string, string>
}

/** Evaluates a whole grid: literals pass through, formulas compute or error. */
export function evaluateSheetGrid(rows: string[][]): SheetEvaluation {
  const context: EvaluationContext = { rows, memo: new Map(), visiting: new Set() }
  const errors = new Map<string, string>()
  const display = rows.map((row, rowIndex) =>
    row.map((raw, colIndex) => {
      if (!raw.startsWith('=')) return raw
      try {
        const value = cellScalar(context, rowIndex, colIndex)
        return toText(value)
      } catch (error) {
        const code = error instanceof FormulaError ? error.code : '#ERROR!'
        errors.set(`${rowIndex}:${colIndex}`, code)
        return code
      }
    })
  )
  return { display, errors }
}

/** Single-cell evaluation used by the xlsx writer for cached formula values. */
export function evaluateFormulaCell(
  rows: string[][],
  row: number,
  col: number
): { value: FormulaScalar | null; error: string | null } {
  const context: EvaluationContext = { rows, memo: new Map(), visiting: new Set() }
  try {
    return { value: cellScalar(context, row, col), error: null }
  } catch (error) {
    return { value: null, error: error instanceof FormulaError ? error.code : '#ERROR!' }
  }
}
