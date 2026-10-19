/**
 * The footer of a card on GitLab (spec 0037 §7.3): the text, date and number
 * fields a label cannot carry (`Working session`, `Session history`, a
 * declared `Publish date`), at the end of the description, below the
 * digest comment and outside it, so that a mark never makes the body look
 * changed. A rule, then one line per field with a value:
 *
 * ```
 * <!-- rness 1a2b3c4d5e6f -->
 *
 * ---
 *
 * **Working session**: claude · 1a2b3c4d
 * ```
 */

const FIELD = /^\*\*([^*\n]+)\*\*: ?(.*?)\s*$/

/** The description cut where its footer begins: the body above, the fields' values by name. */
export function splitFooter(description: string): {
  body: string
  values: Record<string, string>
} {
  const text = description.replace(/\r\n?/g, '\n').trimEnd()
  const at = text.lastIndexOf('\n\n---\n\n')
  if (at < 0) return { body: text, values: {} }
  const lines = text
    .slice(at + '\n\n---\n\n'.length)
    .split('\n')
    .filter((l) => l.trim() !== '')
  const values: Record<string, string> = {}
  for (const line of lines) {
    const m = FIELD.exec(line)
    if (m === null || m[1] === undefined || m[2] === undefined)
      return { body: text, values: {} }
    values[m[1]] = m[2]
  }
  return lines.length === 0
    ? { body: text, values: {} }
    : { body: text.slice(0, at), values }
}

/** `body` with the footer of `values`: the names of `order` first, then the others as given; an empty value is left out. */
export function withFooter(
  body: string,
  values: Readonly<Record<string, string | null>>,
  order: readonly string[]
): string {
  const names = [
    ...order.filter((n) => Object.hasOwn(values, n)),
    ...Object.keys(values).filter((n) => !order.includes(n)),
  ]
  const lines = names.flatMap((n) => {
    const v = values[n]
    return v === null || v === undefined || v === '' ? [] : [`**${n}**: ${v}`]
  })
  return lines.length === 0 ? body : `${body}\n\n---\n\n${lines.join('\n')}`
}
