import { join } from 'node:path'

import { collectMarkdown } from './collect.ts'
import { COLLECTIONS } from './context.ts'
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

/** Human-readable problems across every collection; empty when the tree is valid. */
export async function checkContract(rnessDir: string): Promise<string[]> {
  const problems: string[] = []
  for (const name of COLLECTIONS) {
    const allowed = STATUSES[name]
    const items = await collectMarkdown(join(rnessDir, name))
    for (const item of items) {
      const where = `${name}/${item.rel}`
      if (SKIP.has(where)) continue
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
