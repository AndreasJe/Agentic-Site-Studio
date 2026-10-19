// Project IDs (plan §11.2): lower-case letters and digits, no hyphens; the same rules as the
// prototype (design/prototype/Projects.dc.html), so the preview and the server always agree.

export function toSlug(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/** The slug if free, otherwise the slug with the lowest free number from 2 upward. */
export function suggestSlug(slug: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(slug)) return slug
  let n = 2
  while (used.has(`${slug}${n}`)) n++
  return `${slug}${n}`
}
