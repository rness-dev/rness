import { posix } from 'node:path'

/** A document's number: the `NNNN` its file name starts with, else null. */
export function documentNumber(rel: string): string | null {
  const base = posix.basename(rel)
  // A dated file name (`2026-10-02-slug`) starts with four digits too: a
  // date, not a number.
  if (/^\d{4}-\d{2}-\d{2}-/.test(base)) return null
  return /^(\d{4})-/.exec(base)?.[1] ?? null
}

/** The scaffold's heading is `NNNN — Title`; the number is shown once. */
export function documentTitle(heading: string, number: string | null): string {
  if (number === null) return heading
  const rest = new RegExp(`^${number}\\s*[—–:-]\\s*(.+)$`).exec(heading)?.[1]
  return rest ?? heading
}
