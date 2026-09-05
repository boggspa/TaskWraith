/** Serializes publication windows without changing a command's authority or result. */
export type HostProjectionOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>

export function createHostProjectionSerialQueue(): HostProjectionOperationRunner {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }
}
