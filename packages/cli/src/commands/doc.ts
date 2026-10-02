import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { collectMarkdown } from '../core/collect.ts'
import { STATUSES } from '../core/contract.ts'
import { documentNumber } from '../core/documents.ts'
import { scaffoldDir } from '../core/scaffold.ts'
import type { CollectionName } from '../core/types.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'

/** The collections whose documents are numbered: the ones with a status. */
const NUMBERED = Object.keys(STATUSES) as CollectionName[]

/** The sections a new document opens with, by collection; an ADR's come from its template. */
const SECTIONS: Partial<Record<CollectionName, readonly string[]>> = {
  specs: [
    'Summary',
    'Scope',
    'Out of scope',
    'Alternatives considered',
    'To verify',
    'Tests',
  ],
  plans: ['Decided here, where the specification leaves it open', 'Tasks'],
}

/** A few lowercase words of the title joined by hyphens, as the skills make it. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug === '' ? 'untitled' : slug
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The `## ` headings of an ADR template, in order: its sections without their guidance. */
function headingsOf(template: string): string[] {
  return [...template.matchAll(/^## (.+)$/gm)].map((m) => (m[1] ?? '').trim())
}

async function adrSections(rnessDir: string): Promise<string[]> {
  const own = join(rnessDir, 'adr', '0000-template.md')
  const shipped = join(scaffoldDir(), 'adr', '0000-template.md')
  for (const file of [own, shipped]) {
    try {
      const sections = headingsOf(await readFile(file, 'utf8'))
      if (sections.length > 0) return sections
    } catch {
      // the next one
    }
  }
  return ['Context', 'Decision', 'Alternatives Considered', 'Consequences']
}

/**
 * `rness doc new <collection> [--title]` (spec 0028 §9): the next number of
 * the collection, the file with the collection's front matter and opening
 * sections, its path printed. The number comes from the files present, so
 * every runtime and a bare terminal get the same one; never overwrites.
 */
export async function docNewCommand(
  collection: string,
  opts: { title?: string; cwd?: string }
): Promise<number> {
  if (!(NUMBERED as string[]).includes(collection)) {
    process.stderr.write(
      `${collection} is not a numbered collection of this workspace (${NUMBERED.join(', ')})\n`
    )
    return 2
  }
  const name = collection as CollectionName
  try {
    const ws = await findWorkspace(opts.cwd ?? process.cwd())
    const dir = join(ws.rnessDir, name)
    // A collection the scaffold made empty, or a workspace without it yet.
    await mkdir(dir, { recursive: true })
    let highest = 0
    for (const item of await collectMarkdown(dir)) {
      const number = documentNumber(item.rel)
      if (number !== null) highest = Math.max(highest, Number(number))
    }
    const number = String(highest + 1).padStart(4, '0')
    const title = opts.title?.trim() || 'Untitled'
    const file = join(dir, `${number}-${slugOf(title)}.md`)
    const status = STATUSES[name]?.[0] ?? 'Draft'
    const date = today()
    const front = [
      '---',
      `date: ${date}`,
      `status: ${status}`,
      "repo: ''",
      // An ADR is never updated once accepted: no `updated` (CONVENTIONS.md).
      ...(name === 'adr' ? [] : [`updated: ${date}`]),
      '---',
    ]
    const sections =
      name === 'adr' ? await adrSections(ws.rnessDir) : (SECTIONS[name] ?? [])
    const body = [
      `# ${number} — ${title}`,
      // The rule under the title, as the ADR and specification templates draw it.
      ...(name === 'plans' ? [] : ['', '---']),
      ...sections.flatMap((s) => ['', `## ${s}`]),
    ]
    try {
      await access(file)
      process.stderr.write(`${file} exists; nothing written\n`)
      return 1
    } catch {
      // absent: ours to write
    }
    await writeFile(file, `${[...front, '', ...body].join('\n')}\n`, {
      flag: 'wx',
    })
    process.stdout.write(`${file}\n`)
    return 0
  } catch (e) {
    return reportError(e)
  }
}
