import { relative } from 'node:path'
import { posix, sep } from 'node:path'
import { findWorkspace } from '../core/workspace.ts'
import { loadManifest } from '../core/manifest.ts'
import { resolveScope } from '../core/scope.ts'
import { assembleContext } from '../core/context.mjs'
import { usage } from './index.mjs'

function needsValue(args, i) {
  const value = args[i + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function parse(args) {
  const opts = { json: false, scope: undefined, cwd: process.cwd() }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--json') {
      opts.json = true
    } else if (arg === '--scope') {
      const value = needsValue(args, i)
      if (value === undefined) return { ok: false }
      opts.scope = value
      i += 1
    } else if (arg === '--cwd') {
      // --cwd is an internal flag for tests; not part of the public interface.
      const value = needsValue(args, i)
      if (value === undefined) return { ok: false }
      opts.cwd = value
      i += 1
    } else {
      return { ok: false }
    }
  }
  return { ok: true, opts }
}

export async function contextCommand(args) {
  const parsed = parse(args)
  if (!parsed.ok) {
    process.stderr.write(usage())
    return 2
  }
  const opts = parsed.opts
  let ws
  try {
    ws = await findWorkspace(opts.cwd)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 1
  }
  let manifest
  try {
    manifest = await loadManifest(ws.rnessDir)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 1
  }

  let scope
  if (opts.scope !== undefined) {
    if (!Object.hasOwn(manifest.scopes, opts.scope)) {
      process.stderr.write(`unknown scope: ${opts.scope}\n`)
      return 1
    }
    scope = opts.scope
  } else {
    const rel = relative(ws.root, opts.cwd).split(sep).join(posix.sep)
    scope = resolveScope(manifest, rel)
  }

  let ctx
  try {
    ctx = await assembleContext({ rnessDir: ws.rnessDir, manifest, scope })
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 1
  }

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
