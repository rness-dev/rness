import { join } from 'node:path'

import { exists } from '../core/fs.ts'
import { loadManifest, parseRepoSpec, resolveOrg } from '../core/manifest.ts'
import { DEFAULT_HOST, SSH_HOST } from '../core/remote.ts'
import {
  type AddRepositoryResult,
  addRepository,
  workspaceDirs,
} from '../core/repos.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { syncCommand } from './sync.ts'

export interface AddOptions {
  /** Comma-separated sub-directories to declare as scopes extending the repository scope. */
  scopes?: string
  ssh?: boolean
  /** Internal: remote base (`https://github.com/`, `git@github.com:`, `file:///…/`). */
  host?: string
  yes?: boolean
  /** Internal (tests): directory to resolve from. */
  cwd?: string
}

function isTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/** One `declared scope …` line per scope of `result` not named in `already`. */
function printDeclared(
  result: AddRepositoryResult,
  already: ReadonlySet<string>
): void {
  for (const name of result.declared) {
    if (already.has(name)) continue
    const entry = result.manifest.scopes[name]
    if (entry === undefined) continue
    const ext =
      entry.extends.length === 0 ? '' : `, extends ${entry.extends.join(', ')}`
    process.stdout.write(`declared scope ${name} (${entry.path}${ext})\n`)
  }
}

/** `rness add <repo>`: clone or adopt, declare, sync (spec 0003 §3). Returns the exit code. */
export async function addCommand(
  spec: string,
  opts: AddOptions
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const host = opts.host ?? (opts.ssh === true ? SSH_HOST : DEFAULT_HOST)
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const { org, warning } = resolveOrg(manifest, ws.root)
    if (warning !== null) process.stderr.write(`warning: ${warning}\n`)

    let parsed: { name: string; url: string }
    try {
      parsed = parseRepoSpec(spec, org, host)
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      return 2
    }

    const scopes = (opts.scopes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const dir = join(ws.root, 'org', parsed.name)
    const present = await exists(dir)

    if (opts.yes !== true) {
      if (!isTty()) {
        process.stderr.write(
          'rness add clones and writes files; pass --yes to run without a prompt\n'
        )
        return 2
      }
      const { confirm, isCancel } = await import('@clack/prompts')
      const plan = present
        ? `adopt org/${parsed.name}`
        : `clone ${parsed.url} into org/${parsed.name}`
      const ok = await confirm({
        message: `${plan}, declare scope "${parsed.name}" in rness.json, then sync?`,
      })
      if (isCancel(ok) || ok !== true) {
        process.stderr.write('cancelled\n')
        return 1
      }
    }

    let result = await addRepository({
      root: ws.root,
      rnessDir: ws.rnessDir,
      manifest,
      spec,
      org,
      host,
      scopes,
    })
    process.stdout.write(
      `${result.action === 'cloned' ? 'cloned  ' : 'adopted '} org/${result.name}\n`
    )
    const announced = new Set<string>()
    printDeclared(result, announced)
    for (const name of result.declared) announced.add(name)

    // A monorepo's workspace packages are only knowable once the clone is on
    // disk, so the offer comes after it and adds to what is already declared.
    if (opts.yes !== true && scopes.length === 0) {
      const candidates = await workspaceDirs(dir)
      if (candidates.length > 0) {
        const { isCancel, multiselect } = await import('@clack/prompts')
        const picked = await multiselect({
          message: 'Declare these workspace packages as scopes?',
          options: candidates.map((c) => ({ value: c, label: c })),
          required: false,
        })
        if (isCancel(picked)) {
          process.stderr.write('cancelled\n')
          return 1
        }
        // `isCancel` narrows only the unique cancel symbol, not the broader
        // `symbol` half of clack's `Value[] | symbol` return type, so an array
        // check is what narrows the rest.
        if (Array.isArray(picked) && picked.length > 0) {
          result = await addRepository({
            root: ws.root,
            rnessDir: ws.rnessDir,
            manifest: result.manifest,
            spec,
            org,
            host,
            scopes: picked,
          })
          printDeclared(result, announced)
        }
      }
    }
    return syncCommand({ yes: true, cwd: ws.root })
  } catch (e) {
    return reportError(e)
  }
}
