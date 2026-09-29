import { posix } from 'node:path'

/** A document's number: the `NNNN` its file name starts with, else null. */
export function documentNumber(rel: string): string | null {
  return /^(\d{4})-/.exec(posix.basename(rel))?.[1] ?? null
}

/** The scaffold's heading is `NNNN — Title`; the number is shown once. */
export function documentTitle(heading: string, number: string | null): string {
  if (number === null) return heading
  const rest = new RegExp(`^${number}\\s*[—–:-]\\s*(.+)$`).exec(heading)?.[1]
  return rest ?? heading
}
