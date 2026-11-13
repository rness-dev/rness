// The pattern is the point: it names the control characters it refuses.
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** True when `text` holds a control character (C0, DEL, C1). */
export const hasControl = (text: string): boolean => CONTROL.test(text)

/**
 * `text` safe to print on a terminal: a tab, a carriage return or a line feed
 * becomes a space and every other control character (C0, DEL, C1) a `?`, so a value taken from a skill cannot move the cursor, clear a
 * line or recolour the consent question.
 */
export const plainText = (text: string): string =>
  text.replace(/[\t\r\n]/g, ' ').replace(new RegExp(CONTROL.source, 'g'), '?')

/**
 * `text` as a quoted string that cannot act on a terminal: JSON quoting plus
 * an escape for DEL and C1 controls, which JSON leaves as they are. For a
 * value taken from a skill, a fetched tree or the manifest in a message.
 */
export const quoted = (text: string): string =>
  JSON.stringify(text).replace(
    new RegExp(CONTROL.source, 'g'),
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
