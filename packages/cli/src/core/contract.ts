import { join } from 'node:path'
import { collectMarkdown } from './collect.ts'

export const STATUSES: Record<'adr' | 'specs' | 'plans', readonly string[]> = {
  adr: ['Proposed', 'Accepted', 'Rejected', 'Superseded'],
  specs: ['Draft', 'Proposed', 'Approved', 'Implemented', 'Superseded', 'Rejected'],
  plans: ['Draft', 'Ready', 'In progress', 'Blocked', 'Completed', 'Abandoned'],
}
const SKIP = new Set(['0000-template.md'])

/** Human-readable problems in `adr/`, `specs/`, `plans/`; empty when the tree is valid. */
export async function checkContract(rnessDir: string): Promise<string[]> {
  const problems: string[] = []
  for (const [name, allowed] of Object.entries(STATUSES)) {
    const items = await collectMarkdown(join(rnessDir, name))
    for (const item of items) {
      if (SKIP.has(item.rel)) continue
      const where = `${name}/${item.rel}`
      if (item.fieldsError !== null) {
        problems.push(`${where}: invalid front matter (${item.fieldsError})`)
        continue
      }
      if (item.fields === null) {
        problems.push(`${where}: missing a front-matter block`)
        continue
      }
      if (item.title === null) problems.push(`${where}: missing a "# " title`)
      const status = item.fields.status
      if (status === undefined || status === null || status === '') {
        problems.push(`${where}: missing "status"`)
      } else if (typeof status !== 'string' || !allowed.includes(status)) {
        problems.push(`${where}: unknown status ${JSON.stringify(status)} (expected ${allowed.join(', ')})`)
      }
    }
  }
  return problems
}
