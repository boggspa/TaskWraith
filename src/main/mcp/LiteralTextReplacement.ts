function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function replaceLiteralText(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): string {
  if (!oldString) throw new Error('old_string is required.')

  const firstIndex = original.indexOf(oldString)
  if (firstIndex >= 0) {
    if (replaceAll) return original.split(oldString).join(newString)
    return `${original.slice(0, firstIndex)}${newString}${original.slice(
      firstIndex + oldString.length
    )}`
  }

  const lines = oldString.split(/\r?\n/)
  const regexParts = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return '\\s*'
    return '[ \\t]*' + escapeRegExp(trimmed) + '[ \\t]*'
  })
  const pattern = regexParts.join('\\r?\\n')
  const fuzzyRegex = new RegExp(pattern, replaceAll ? 'g' : '')

  const match = original.match(fuzzyRegex)
  if (!match) {
    throw new Error('old_string was not found in the target file.')
  }

  return original.replace(fuzzyRegex, () => newString)
}
