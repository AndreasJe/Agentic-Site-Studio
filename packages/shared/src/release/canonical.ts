// Canonical JSON (RFC 8785, restricted to safe integers): the exact bytes a command signature
// covers (decisions #26). Keys are sorted by UTF-16 code units at every level, no whitespace.

const MAX_DEPTH = 32

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error('canonical JSON nested too deeply')
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error('canonical JSON allows only safe integers')
      return String(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null)
        throw new Error('canonical JSON needs plain objects')
      const record = value as Record<string, unknown>
      const parts = Object.keys(record)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k], depth + 1)}`)
      return `{${parts.join(',')}}`
    }
    default:
      throw new Error(`canonical JSON cannot encode ${typeof value}`)
  }
}
