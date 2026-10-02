import { posix } from 'node:path'

/**
 * The date of a dated file name (`2026-10-02-slug.md`), the naming of other
 * agents' plan skills. A plausible date only: `0039-10-02-review.md` is
 * document 0039 with a title that starts with digits.
 */
export function documentDate(rel: string): string | null {
  return (
    /^((?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))-/.exec(
      posix.basename(rel)
    )?.[1] ?? null
  )
}

/** A document's number: the `NNNN` its file name starts with, else null. */
export function documentNumber(rel: string): string | null {
  // A dated file name starts with four digits too: a date, not a number.
  if (documentDate(rel) !== null) return null
  return /^(\d{4})-/.exec(posix.basename(rel))?.[1] ?? null
}

/** The scaffold's heading is `NNNN — Title`; the number is shown once. */
export function documentTitle(heading: string, number: string | null): string {
  if (number === null) return heading
  const rest = new RegExp(`^${number}\\s*[—–:-]\\s*(.+)$`).exec(heading)?.[1]
  return rest ?? heading
}
