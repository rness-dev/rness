// The pattern is the point: it names the control characters it refuses.
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** True when `text` holds a control character (C0, DEL, C1). */
export const hasControl = (text: string): boolean => CONTROL.test(text)

/**
 * The characters that reorder or hide text on a terminal without being
 * control characters: zero-width ones (U+200B to U+200F, U+FEFF) and the
 * bidirectional embeddings, overrides and isolates (U+202A to U+202E,
 * U+2066 to U+2069). A file name or a skill name has no use for them.
 */
export const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

/** CONTROL and INVISIBLE together: what never reaches a terminal raw. */
const UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/**
 * `text` safe to print on a terminal: a tab, a carriage return or a line feed
 * becomes a space and every other control character (C0, DEL, C1), zero-width
 * or bidirectional character a `?`, so a value taken from a skill cannot move
 * the cursor, clear a line, recolour the consent question or reorder it.
 */
export const plainText = (text: string): string =>
  text.replace(/[\t\r\n]/g, ' ').replace(UNSAFE, '?')

/**
 * `text` as a quoted string that cannot act on a terminal: JSON quoting plus
 * an escape for DEL, C1, zero-width and bidirectional characters, which JSON
 * leaves as they are. For a value taken from a skill, a fetched tree or the
 * manifest in a message.
 */
export const quoted = (text: string): string =>
  JSON.stringify(text).replace(
    UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
