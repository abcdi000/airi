/** Produces an Electron structured-clone-safe JSON DTO. */
export function cloneIpcValue<T>(value: T): T {
  if (value === undefined)
    return value
  return JSON.parse(JSON.stringify(value)) as T
}

export function cloneIpcRecord(value: unknown): Record<string, unknown> {
  const plain = cloneIpcValue(value)
  return plain && typeof plain === 'object' && !Array.isArray(plain)
    ? plain as Record<string, unknown>
    : {}
}
