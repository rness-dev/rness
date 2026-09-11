import { join } from 'node:path'
import { collectMarkdown } from './collect.ts'

const STATUSES = {
  adr: ['Proposed', 'Accepted', 'Rejected', 'Superseded'],
  specs: ['Draft', 'Proposed', 'Approved', 'Implemented', 'Superseded', 'Rejected'],
  plans: ['Draft', 'Ready', 'In progress', 'Blocked', 'Completed', 'Abandoned'],
}
const SKIP = new Set(['0000-template.md'])

export async function checkContract(rnessDir) {
  const problems = []
  for (const [name, allowed] of Object.entries(STATUSES)) {
    const items = await collectMarkdown(join(rnessDir, name))
    for (const item of items) {
      if (SKIP.has(item.rel)) continue
      const where = `${name}/${item.rel}`
      if (!item.fields) {
        problems.push(`${where}: missing a front-matter block`)
        continue
      }
      if (!item.title) problems.push(`${where}: missing a "# " title`)
      const status = item.fields.status
      if (!status) problems.push(`${where}: missing "status"`)
      else if (!allowed.includes(status)) {
        problems.push(`${where}: unknown status "${status}" (expected ${allowed.join(', ')})`)
      }
    }
  }
  return problems
}
