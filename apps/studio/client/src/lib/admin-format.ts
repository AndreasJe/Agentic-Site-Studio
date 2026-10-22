// Small formatting helpers shared by the M8 Admin screens.
import { codeText } from './admin-strings.ts'

export function fmtAt(iso: string | null | undefined, lang: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB')
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const fmtNum = (n: number, lang: string) =>
  n.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB')

/** A refusal code as a sentence from a screen's own map, then the shared one. */
export function errText(code: string | undefined, own: Record<string, string>): string {
  return (code && own[code]) || codeText(code)
}
