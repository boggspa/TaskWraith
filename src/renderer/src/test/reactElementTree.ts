import { isValidElement, type ReactElement, type ReactNode } from 'react'

type ButtonElement = ReactElement<{
  children?: ReactNode
  onClick?: (event?: unknown) => void
}>

type ClickableElement = ReactElement<{
  children?: ReactNode
  className?: string
  onClick?: (event?: unknown) => void
}>

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

function findButtonByTextOrNull(node: ReactNode, text: string): ButtonElement | null {
  if (isValidElement<{ children?: ReactNode }>(node)) {
    if (node.type === 'button' && nodeText(node.props.children).includes(text)) {
      return node as ButtonElement
    }
    const children = node.props.children
    const childNodes = Array.isArray(children) ? children : [children]
    for (const child of childNodes) {
      const result = findButtonByTextOrNull(child, text)
      if (result) return result
    }
  }
  return null
}

export function findButtonByText(node: ReactNode, text: string): ButtonElement {
  const result = findButtonByTextOrNull(node, text)
  if (!result) throw new Error(`Button not found: ${text}`)
  return result
}

function findClickableByClassNameOrNull(
  node: ReactNode,
  className: string
): ClickableElement | null {
  if (isValidElement<{ children?: ReactNode; className?: string; onClick?: unknown }>(node)) {
    const classNames = node.props.className?.split(/\s+/) ?? []
    if (classNames.includes(className) && typeof node.props.onClick === 'function') {
      return node as ClickableElement
    }
    const children = node.props.children
    const childNodes = Array.isArray(children) ? children : [children]
    for (const child of childNodes) {
      const result = findClickableByClassNameOrNull(child, className)
      if (result) return result
    }
  }
  return null
}

export function findClickableByClassName(node: ReactNode, className: string): ClickableElement {
  const result = findClickableByClassNameOrNull(node, className)
  if (!result) throw new Error(`Clickable element not found: ${className}`)
  return result
}
