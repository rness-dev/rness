import { join } from 'node:path'

import { exists } from '../core/fs.ts'
import { loadManifest, parseRepoSpec, resolveOrg } from '../core/manifest.ts'
import {
  type AddRepositoryResult,
  addRepository,
  workspaceDirs,
} from '../core/repos.ts'
import { status, warn } from '../core/style.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import {
  CHECKING_LINE,
  type Transport,
  defaultTransport,
  httpsFlagLine,
  isSshUrl,
  sshWorkspaceLines,
  usingLine,
} from '../core/transport.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'
import { syncCommand } from './sync.ts'

export interface AddOptions {
  /** Comma-separated sub-directories to declare as scopes extending the repository scope. */
  scopes?: string
  /** Force `git@github.com:` without the SSH test. */
  ssh?: boolean
  /** Force `https://github.com/` without the SSH test. */
  https?: boolean
  /** Internal: remote base (`file:///…/`, another host); wins over both flags and skips the SSH test. */
  host?: string
  yes?: boolean
  /** Internal (tests): directory to resolve from. */
  cwd?: string
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
    process.stdout.write(
      `${status('declared', `scope ${name} (${entry.path}${ext})`)}\n`
    )
  }
}

const FULL_URL = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/

/**
 * `rness add <repo>`: clone or adopt, declare, sync (spec 0003 §3). A name is
 * written over SSH when github.com accepts the user's key, over HTTPS
 * otherwise — except in a workspace that clones over SSH, which never falls
 * back silently (spec 0005). Returns the exit code.
 */
export async function addCommand(
  spec: string,
  opts: AddOptions,
  terminal: Terminal = defaultTerminal,
  transport: Transport = defaultTransport
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  if (opts.ssh === true && opts.https === true) {
    process.stderr.write('--ssh and --https cannot be combined\n')
    return 2
  }
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const { org, warning } = resolveOrg(manifest, ws.root)
    if (warning !== null) process.stderr.write(`${warn(warning)}\n`)

    // The name is checked before anything else runs; the host comes later.
    let parsed: { name: string; url: string }
    try {
      parsed = parseRepoSpec(spec, org, transport.hosts.https)
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      return 2
    }
    const interactive = opts.yes !== true
    if (interactive && !terminal.isTty()) {
      process.stderr.write(
        'rness add clones and writes files; pass --yes to run without a prompt\n'
      )
      return 2
    }

    let host = opts.host
    if (host === undefined && opts.ssh === true) host = transport.hosts.ssh
    if (host === undefined && opts.https === true) host = transport.hosts.https
    if (host === undefined && FULL_URL.test(spec)) host = transport.hosts.https
    if (host === undefined) {
      if (interactive) process.stdout.write(`${CHECKING_LINE}\n`)
      const access = await transport.detect({ interactive })
      const overSsh = Object.values(manifest.repos).some((r) =>
        isSshUrl(r.url, transport.hosts)
      )
      if (access.ok || !overSsh) {
        process.stdout.write(`${usingLine(access)}\n`)
        host = access.ok ? transport.hosts.ssh : transport.hosts.https
      } else {
        // An SSH workspace never falls back silently: say why, then let the
        // user choose HTTPS for this one repository.
        const lines = sshWorkspaceLines(access.reason)
        if (!interactive) {
          process.stderr.write(
            `${[...lines, httpsFlagLine(spec)].join('\n')}\n`
          )
          return 1
        }
        process.stderr.write(`${lines.join('\n')}\n`)
        const p = await terminal.prompts()
        const https = await p.confirm({
          message: `Clone ${parsed.name} over HTTPS instead?`,
          initialValue: false,
        })
        if (p.isCancel(https) || https !== true) return 1
        host = transport.hosts.https
      }
    }
    parsed = parseRepoSpec(spec, org, host)

    const scopes = (opts.scopes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const dir = join(ws.root, 'org', parsed.name)
    const present = await exists(dir)

    if (interactive) {
      const { confirm, isCancel } = await terminal.prompts()
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
    process.stdout.write(`${status(result.action, `org/${result.name}`)}\n`)
    const announced = new Set<string>()
    printDeclared(result, announced)
    for (const name of result.declared) announced.add(name)

    // A monorepo's workspace packages are only knowable once the clone is on
    // disk, so the offer comes after it and adds to what is already declared.
    if (opts.yes !== true && scopes.length === 0) {
      const candidates = await workspaceDirs(dir)
      if (candidates.length > 0) {
        const { isCancel, multiselect } = await terminal.prompts()
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
