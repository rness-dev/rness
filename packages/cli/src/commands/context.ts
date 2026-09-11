import { posix, relative, sep } from 'node:path'
import { findWorkspace } from '../core/workspace.ts'
import { loadManifest } from '../core/manifest.ts'
import { resolveScope } from '../core/scope.ts'
import { assembleContext } from '../core/context.ts'
import type { Context } from '../core/types.ts'
import { reportError } from '../report.ts'

export interface ContextOptions {
  /** Scope to resolve; default: the scope owning `cwd`. */
  scope?: string
  /** Print the resolved context as JSON instead of Markdown. */
  json?: boolean
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
}

export function renderMarkdown(ctx: Context): string {
  const parts: string[] = []
  for (const collection of ctx.collections) {
    if (collection.files.length === 0) continue
    parts.push(`## ${collection.name}\n`)
    for (const file of collection.files) {
      parts.push(`<!-- rness: ${collection.name}/${file.rel} -->\n${file.body.trim()}\n`)
    }
  }
  return `${parts.join('\n')}\n`
}

/** `rness context`: resolve and print the context for a scope. Returns the exit code. */
export async function contextCommand(opts: ContextOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)

    let scope: string | null
    if (opts.scope !== undefined) {
      if (!Object.hasOwn(manifest.scopes, opts.scope)) {
        process.stderr.write(`unknown scope: ${opts.scope}\n`)
        return 1
      }
      scope = opts.scope
    } else {
      const rel = relative(ws.root, cwd).split(sep).join(posix.sep)
      scope = resolveScope(manifest, rel)
    }

    const ctx = await assembleContext({ rnessDir: ws.rnessDir, manifest, scope })
    process.stdout.write(opts.json ? `${JSON.stringify(ctx, null, 2)}\n` : renderMarkdown(ctx))
    return 0
  } catch (e) {
    return reportError(e)
  }
}
