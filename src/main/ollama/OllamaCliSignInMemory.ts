/**
 * The durable memory of the Ollama daemon's account state lives in
 * `host-shared`, where the pure-Node Host applies the same remembering rule to
 * its own catalogue; main re-exports it so its consumers and the
 * settings-owned record keep one implementation.
 */
export * from '../../host-shared/ollama/OllamaCliSignInMemory'
