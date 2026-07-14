export function replaceLiteralText(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): string {
  if (!oldString) throw new Error('old_string is required.')

  const firstIndex = original.indexOf(oldString)
  if (firstIndex < 0) {
    throw new Error('old_string was not found in the target file.')
  }

  if (replaceAll) return original.split(oldString).join(newString)

  return `${original.slice(0, firstIndex)}${newString}${original.slice(
    firstIndex + oldString.length
  )}`
}
