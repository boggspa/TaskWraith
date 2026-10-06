/** Hydrate evidence before exposing consumers that can admit or settle saves. */
export async function startThreadOwnershipConsumers(options: {
  hydrate(): Promise<void>
  install(): void
  registerOwner(): Promise<void>
  start(): void
}): Promise<void> {
  await options.hydrate()
  options.install()
  await options.registerOwner()
  options.start()
}
