const SECRET_FIELD_RE =
  /(^|[_-])(api[_-]?key|access[_-]?token|auth[_-]?token|bearer|client[_-]?secret|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)([_-]|$)/i

const SECRET_HEADER_RE =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-client-secret|x-github-token|x-token)$/i

const ENV_REFERENCE_RE =
  /^\s*(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\s*$/

const HEADER_ENV_REFERENCE_RE =
  /^\s*(?:Bearer\s+)?(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\s*$/i

export function isLikelySecretFieldName(name: string): boolean {
  const trimmed = name.trim()
  return Boolean(trimmed && SECRET_FIELD_RE.test(trimmed))
}

export function isLikelySecretHeaderName(name: string): boolean {
  const trimmed = name.trim()
  return Boolean(trimmed && (SECRET_HEADER_RE.test(trimmed) || isLikelySecretFieldName(trimmed)))
}

export function isSecretReferenceValue(value: string, kind: 'env' | 'header' = 'env'): boolean {
  const trimmed = value.trim()
  return kind === 'header' ? HEADER_ENV_REFERENCE_RE.test(trimmed) : ENV_REFERENCE_RE.test(trimmed)
}

export function canPersistPlaintextFieldValue(input: {
  key: string
  value: string
  kind: 'env' | 'header'
}): boolean {
  const secretKey =
    input.kind === 'header'
      ? isLikelySecretHeaderName(input.key)
      : isLikelySecretFieldName(input.key)
  if (!secretKey) return true
  return isSecretReferenceValue(input.value, input.kind)
}
