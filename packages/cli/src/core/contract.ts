import { join } from 'node:path'

import { collectMarkdown, markdownItem } from './collect.ts'
import { COLLECTIONS } from './context.ts'
import { documentNumber } from './documents.ts'
import type { CollectionName } from './types.ts'

/** Collections whose files must carry front matter with a `status`. */
export const STATUSES: Partial<Record<CollectionName, readonly string[]>> = {
  adr: ['Proposed', 'Accepted', 'Rejected', 'Superseded'],
  specs: [
    'Draft',
    'Proposed',
    'Approved',
    'Implemented',
    'Superseded',
    'Rejected',
  ],
  plans: ['Draft', 'Ready', 'In progress', 'Blocked', 'Completed', 'Abandoned'],
}
const SKIP = new Set(['adr/0000-template.md'])
/** Front-matter keys from the withdrawn routing feature — the directory decides. */
const PLACEMENT_KEYS = ['scopes', 'scope'] as const

/**
 * One file of `.rness/` read from a text rather than the disk: what an edit
 * would leave, checked before it is written (spec 0029 §4.3).
 */
export interface ContractOverride {
  /** `.rness/`-relative, POSIX: `specs/0001-a.md`. */
  rel: string
  text: string
}

/** The collection's files, with the override in place of (or beside) its file. */
async function itemsOf(
  rnessDir: string,
  name: CollectionName,
  override: ContractOverride | undefined
) {
  const items = await collectMarkdown(join(rnessDir, name))
  const prefix = `${name}/`
  if (override === undefined || !override.rel.startsWith(prefix)) return items
  const rel = override.rel.slice(prefix.length)
  const item = markdownItem(
    join(rnessDir, ...override.rel.split('/')),
    rel,
    override.text
  )
  return [...items.filter((i) => i.rel !== rel), item].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  )
}

/**
 * Human-readable problems across every collection; empty when the tree is
 * valid. With an override, that one file is read from its text.
 */
export async function checkContract(
  rnessDir: string,
  override?: ContractOverride
): Promise<string[]> {
  const problems: string[] = []
  for (const name of COLLECTIONS) {
    const allowed = STATUSES[name]
    const items = await itemsOf(rnessDir, name, override)
    // One number, one document (spec 0028 §9): the clash a merge of two
    // branches that each made the next document can still produce.
    const byNumber = new Map<string, string[]>()
    for (const item of items) {
      const where = `${name}/${item.rel}`
      if (SKIP.has(where)) continue
      const number = allowed === undefined ? null : documentNumber(item.rel)
      if (number !== null)
        byNumber.set(number, [...(byNumber.get(number) ?? []), where])
    }
    for (const [number, files] of byNumber) {
      if (files.length < 2) continue
      for (const where of files)
        problems.push(
          `${where}: the number ${number} is also that of ${files
            .filter((f) => f !== where)
            .join(', ')}`
        )
    }
    // `rness doc new` numbers every document of these collections; a file
    // written another way (a dated name, a bare slug) gets the next number.
    const next = String(
      Math.max(0, ...[...byNumber.keys()].map(Number)) + 1
    ).padStart(4, '0')
    for (const item of items) {
      const where = `${name}/${item.rel}`
      if (SKIP.has(where)) continue
      if (allowed !== undefined && documentNumber(item.rel) === null)
        problems.push(
          `${where}: not numbered; name it ${next}-<slug>.md, the next number of ${name}`
        )
      if (item.fieldsError !== null) {
        problems.push(`${where}: invalid front matter (${item.fieldsError})`)
        continue
      }
      if (item.fields !== null) {
        for (const key of PLACEMENT_KEYS) {
          if (Object.hasOwn(item.fields, key)) {
            problems.push(
              `${where}: front matter "${key}" is not supported — the directory decides the scope; move the file`
            )
          }
        }
      }
      if (allowed === undefined) continue
      if (item.fields === null) {
        problems.push(`${where}: missing a front-matter block`)
        continue
      }
      if (item.title === null) problems.push(`${where}: missing a "# " title`)
      const status = item.fields['status']
      if (status === undefined || status === null || status === '') {
        problems.push(`${where}: missing "status"`)
      } else if (typeof status !== 'string' || !allowed.includes(status)) {
        problems.push(
          `${where}: unknown status ${JSON.stringify(status)} (expected ${allowed.join(', ')})`
        )
      }
    }
  }
  return problems
}
