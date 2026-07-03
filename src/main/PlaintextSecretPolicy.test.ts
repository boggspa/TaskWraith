import { describe, expect, it } from 'vitest'
import {
  canPersistPlaintextFieldValue,
  isLikelySecretFieldName,
  isLikelySecretHeaderName,
  isSecretReferenceValue
} from './PlaintextSecretPolicy'

describe('PlaintextSecretPolicy', () => {
  it('detects common secret env and header names', () => {
    expect(isLikelySecretFieldName('OPENAI_API_KEY')).toBe(true)
    expect(isLikelySecretFieldName('CLIENT_SECRET')).toBe(true)
    expect(isLikelySecretFieldName('PROJECT_ROOT')).toBe(false)
    expect(isLikelySecretHeaderName('Authorization')).toBe(true)
    expect(isLikelySecretHeaderName('X-API-Key')).toBe(true)
    expect(isLikelySecretHeaderName('X-Figma-Region')).toBe(false)
  })

  it('allows env references but blocks inline secret values for secret fields', () => {
    expect(isSecretReferenceValue('${OPENAI_API_KEY}')).toBe(true)
    expect(isSecretReferenceValue('$OPENAI_API_KEY')).toBe(true)
    expect(isSecretReferenceValue('sk-1234567890abcdefghijklmnop')).toBe(false)
    expect(
      canPersistPlaintextFieldValue({
        key: 'OPENAI_API_KEY',
        value: '${OPENAI_API_KEY}',
        kind: 'env'
      })
    ).toBe(true)
    expect(
      canPersistPlaintextFieldValue({
        key: 'OPENAI_API_KEY',
        value: 'sk-1234567890abcdefghijklmnop',
        kind: 'env'
      })
    ).toBe(false)
  })

  it('allows bearer env references but blocks inline authorization headers', () => {
    expect(isSecretReferenceValue('Bearer ${DOCS_TOKEN}', 'header')).toBe(true)
    expect(isSecretReferenceValue('Bearer live-token-123', 'header')).toBe(false)
    expect(
      canPersistPlaintextFieldValue({
        key: 'Authorization',
        value: 'Bearer ${DOCS_TOKEN}',
        kind: 'header'
      })
    ).toBe(true)
    expect(
      canPersistPlaintextFieldValue({
        key: 'Authorization',
        value: 'Bearer live-token-123',
        kind: 'header'
      })
    ).toBe(false)
  })
})
