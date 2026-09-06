import { relative } from 'node:path'
import { posix, sep } from 'node:path'
import { findWorkspace } from '../core/workspace.mjs'
import { loadManifest } from '../core/manifest.mjs'
import { resolveScope } from '../core/scope.mjs'
import { assembleContext } from '../core/context.mjs'

function parse(args) {
  const opts = { json: false, scope: undefined, cwd: process.cwd() }
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') opts.json = true
    else if (args[i] === '--scope') opts.scope = args[++i]
    else if (args[i] === '--cwd') opts.cwd = args[++i]
  }
  return opts
}

export async function contextCommand(args) {
  const opts = parse(args)
  let ws
  try {
    ws = await findWorkspace(opts.cwd)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 1
  }
  const manifest = await loadManifest(ws.rnessDir)

  let scope
  if (opts.scope !== undefined) {
    if (!manifest.scopes[opts.scope]) {
      process.stderr.write(`unknown scope: ${opts.scope}\n`)
      return 1
    }
    scope = opts.scope
  } else {
    const rel = relative(ws.root, opts.cwd).split(sep).join(posix.sep)
    scope = resolveScope(manifest, rel)
  }

  const ctx = await assembleContext({ rnessDir: ws.rnessDir, manifest, scope })

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(ctx, null, 2)}\n`)
    return 0
  }
  const parts = []
  for (const collection of ctx.collections) {
    if (collection.files.length === 0) continue
    parts.push(`## ${collection.name}\n`)
    for (const file of collection.files) {
      parts.push(`<!-- rness: ${collection.name}/${file.rel} -->\n${file.body.trim()}\n`)
    }
  }
  process.stdout.write(`${parts.join('\n')}\n`)
  return 0
}
