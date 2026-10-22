// Markdown to the Atlassian Document Format, the body of a Jira issue and
// of its comments (spec 0039 §6). marklassian does the conversion; it is
// loaded on the first call only, so `context` and `validate` never load
// it (ADR 0007's budget). What it gets wrong for Jira is set right here.

/** A node of an ADF document, as far as rness reads or writes one. */
export interface AdfNode {
  type: string
  attrs?: Record<string, unknown>
  content?: AdfNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
}

export interface AdfDocument {
  version: 1
  type: 'doc'
  content: AdfNode[]
}

const FENCE = /^\s{0,3}(```|~~~)/

/**
 * Each prose line followed by another ends with a space: marklassian 1.2.1
 * drops the line break before code, bold, a link or emphasis (`word\n**bold**`
 * reads `wordbold`, plan 0053 task 5). A line already ending in a space is
 * left alone (two would make a hard break), and so is fenced code.
 */
export function keepSoftBreaks(markdown: string): string {
  const lines = markdown.split('\n')
  let fenced = false
  return lines
    .map((line, i) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      const next = lines[i + 1]
      if (
        fenced ||
        next === undefined ||
        next.trim() === '' ||
        FENCE.test(next) ||
        line.trim() === '' ||
        /\s$/.test(line)
      )
        return line
      return `${line} `
    })
    .join('\n')
}

/** What a task item may hold: inline nodes. A list or a block in it is refused by Jira (plan 0053 task 1). */
const isBlock = (n: AdfNode): boolean => n.content !== undefined

/**
 * A task list whose items hold blocks: marklassian puts a nested list in
 * the task item, which Jira refuses. A nested task list stays, a sibling of
 * the items (ADF allows it); any other block leaves the task list, which
 * goes on after it under a new id.
 */
function flattenTasks(nodes: readonly AdfNode[]): AdfNode[] {
  return nodes.flatMap((node): AdfNode[] => {
    const content =
      node.content === undefined ? undefined : flattenTasks(node.content)
    const n: AdfNode = content === undefined ? node : { ...node, content }
    if (n.type !== 'taskList') return [n]
    const id = String(n.attrs?.['localId'] ?? 'tasks')
    const out: AdfNode[] = []
    let items: AdfNode[] = []
    const close = (): void => {
      if (items.length === 0) return
      const piece = out.filter((o) => o.type === 'taskList').length
      out.push({
        ...n,
        attrs: { ...n.attrs, localId: piece === 0 ? id : `${id}-${piece}` },
        content: items,
      })
      items = []
    }
    for (const item of n.content ?? []) {
      if (item.type !== 'taskItem') {
        items.push(item)
        continue
      }
      const inline = (item.content ?? []).filter((c) => !isBlock(c))
      const blocks = (item.content ?? []).filter(isBlock)
      items.push({ ...item, content: inline })
      for (const block of blocks) {
        if (block.type === 'taskList') items.push(block)
        else {
          close()
          out.push(block)
        }
      }
    }
    close()
    return out
  })
}

/** The nodes whose text ends where a line did: the space `keepSoftBreaks` left there goes. */
const LINES = new Set(['paragraph', 'heading', 'taskItem'])

function trimEnds(nodes: readonly AdfNode[]): AdfNode[] {
  return nodes.map((node) => {
    if (node.content === undefined) return node
    const content = trimEnds(node.content)
    const last = content.at(-1)
    if (
      LINES.has(node.type) &&
      last?.type === 'text' &&
      last.text !== undefined
    ) {
      const text = last.text.trimEnd()
      return {
        ...node,
        content:
          text === ''
            ? content.slice(0, -1)
            : [...content.slice(0, -1), { ...last, text }],
      }
    }
    return { ...node, content }
  })
}

/** `markdown` as an ADF document: comments dropped (ADF has none: the digest lives in a property), line breaks kept, task lists Jira takes. */
export async function toAdf(markdown: string): Promise<AdfDocument> {
  const { markdownToAdf } = await import('marklassian')
  const doc = markdownToAdf(keepSoftBreaks(markdown.replace(/\r\n?/g, '\n')))
  return {
    version: 1,
    type: 'doc',
    content: trimEnds(flattenTasks(doc.content as AdfNode[])),
  }
}

/**
 * A card's footer (spec 0037 §7.3, on Jira as ADF): a rule, then one
 * paragraph per field with a value, its name strong. Built here rather than
 * from Markdown: marklassian would run the fields into one paragraph.
 */
export function footerAdf(
  values: Readonly<Record<string, string | null>>,
  order: readonly string[]
): AdfNode[] {
  const names = [
    ...order.filter((n) => Object.hasOwn(values, n)),
    ...Object.keys(values).filter((n) => !order.includes(n)),
  ]
  const fields = names.flatMap((name): AdfNode[] => {
    const value = values[name]
    return value === null || value === undefined || value === ''
      ? []
      : [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: name, marks: [{ type: 'strong' }] },
              { type: 'text', text: `: ${value}` },
            ],
          },
        ]
  })
  return fields.length === 0 ? [] : [{ type: 'rule' }, ...fields]
}

/** A footer field's paragraph: its name and value, or null. */
function fieldOf(n: AdfNode): [string, string] | null {
  const [name, value, ...rest] = n.content ?? []
  if (
    n.type !== 'paragraph' ||
    rest.length > 0 ||
    name?.type !== 'text' ||
    name.marks?.length !== 1 ||
    name.marks[0]?.type !== 'strong' ||
    value?.type !== 'text' ||
    value.marks !== undefined ||
    !(value.text ?? '').startsWith(': ')
  )
    return null
  return [name.text ?? '', (value.text ?? '').slice(2).trim()]
}

/** A description cut where its footer begins: the body above the last rule, the fields' values by name; no footer, the whole and {}. */
export function readFooter(doc: AdfDocument): {
  body: AdfNode[]
  values: Record<string, string>
} {
  const at = doc.content.map((n) => n.type).lastIndexOf('rule')
  const fields = at < 0 ? [] : doc.content.slice(at + 1).map(fieldOf)
  if (fields.length === 0 || fields.some((f) => f === null))
    return { body: doc.content, values: {} }
  return {
    body: doc.content.slice(0, at),
    values: Object.fromEntries(fields as [string, string][]),
  }
}

/** The characters Jira counts against its 32,767 limit: the document's text, not its JSON (plan 0053 task 1). */
export function adfTextLength(doc: { content: readonly AdfNode[] }): number {
  const walk = (nodes: readonly AdfNode[]): number =>
    nodes.reduce(
      (sum, n) => sum + (n.text?.length ?? 0) + walk(n.content ?? []),
      0
    )
  return walk(doc.content)
}
