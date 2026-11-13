import { lstat, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import type { CommandDeps } from '../core/deps.ts'
import { loadManifest, writeManifest } from '../core/manifest.ts'
import type { GitCredentials } from '../core/provider.ts'
import { openGitProvider } from '../core/providers.ts'
import {
  type TeamSkill,
  copySkill,
  diffSkillFiles,
  fetchSkill,
  skillConflicts,
  skillFileDigests,
  skillSourceUrl,
  teamSkills,
} from '../core/skills.ts'
import { defaultTerminal } from '../core/terminal.ts'
import type { Manifest, SkillEntry, Workspace } from '../core/types.ts'
import { type Ui, makeUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { reportError } from '../report.ts'

/** What `rness skill <command>` takes from the command line. */
export interface SkillOptions {
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
  /** A repository or a part declared in `rness.json`; absent: the whole organization. */
  scope?: string
  /** `add`: the skill's directory inside a repository source. */
  path?: string
  /** `add`, `update`: a tag, a branch or a commit. */
  ref?: string
  /** `add`: install the skill under another name. */
  name?: string
}

/** A refusal: said as the one line of the error contract, exit 1. */
class Refusal extends Error {}

interface Context {
  ws: Workspace
  manifest: Manifest
  ui: Ui
  credentialsFor: (url: string) => Promise<GitCredentials | null>
}

async function openContext(
  opts: SkillOptions,
  deps: Partial<CommandDeps>
): Promise<Context> {
  const ws = await findWorkspace(opts.cwd ?? process.cwd())
  const manifest = await loadManifest(ws.rnessDir)
  let provider = deps.provider
  return {
    ws,
    manifest,
    ui: deps.ui ?? (await makeUi(deps.terminal ?? defaultTerminal)),
    // Host-matched credentials or none (ruling R16): never a raw token.
    credentialsFor: async (url) =>
      (provider ??=
        (await openGitProvider(manifest)) ?? undefined)?.credentialsFor(url) ??
      null,
  }
}

/** The scope `--scope` names: a key of `manifest.scopes`, else refused naming the known ones. */
function checkScope(manifest: Manifest, scope: string | undefined): void {
  if (scope === undefined || Object.hasOwn(manifest.scopes, scope)) return
  const known = Object.keys(manifest.scopes)
  throw new Refusal(
    `unknown scope "${scope}"${known.length === 0 ? ': this workspace declares none' : `; known scopes: ${known.join(', ')}`}`
  )
}

/** Where `skills.<name>` is held in `rness.json`: at the top, under a repository, or under one of its parts. */
function keyPath(
  manifest: Manifest,
  scope: string | null,
  name: string
): string {
  const chain: string[] = []
  for (
    let at: string | null = scope;
    at !== null;
    at = manifest.scopes[at]?.parent ?? null
  )
    chain.unshift(at)
  return [...chain.map((s) => `scopes.${s}`), `skills.${name}`].join('.')
}

/** `.rness/skills/...` of a skill's directory, as a path with a trailing slash. */
const copyPath = (ws: Workspace, skill: { dir: string }): string =>
  `.rness/${relative(ws.rnessDir, skill.dir).split(sep).join('/')}/`

const levelSkills = (
  manifest: Manifest,
  scope: string | null
): Record<string, SkillEntry> =>
  (scope === null ? manifest.skills : manifest.scopes[scope]?.skills) ?? {}

/** `manifest` with the skills of one level replaced; the key goes when none is left. */
function withLevelSkills(
  manifest: Manifest,
  scope: string | null,
  skills: Record<string, SkillEntry>
): Manifest {
  const kept = Object.keys(skills).length > 0
  if (scope === null) {
    const { skills: _dropped, ...rest } = manifest
    return kept ? { ...rest, skills } : rest
  }
  const entry = manifest.scopes[scope]
  if (entry === undefined) return manifest
  const { skills: _dropped, ...rest } = entry
  return {
    ...manifest,
    scopes: {
      ...manifest.scopes,
      [scope]: kept ? { ...rest, skills } : rest,
    },
  }
}

const withEntry = (
  manifest: Manifest,
  scope: string | null,
  name: string,
  entry: SkillEntry
): Manifest =>
  withLevelSkills(manifest, scope, {
    ...levelSkills(manifest, scope),
    [name]: entry,
  })

function withoutEntry(
  manifest: Manifest,
  scope: string | null,
  name: string
): Manifest {
  const { [name]: _gone, ...rest } = levelSkills(manifest, scope)
  return withLevelSkills(manifest, scope, rest)
}

/** The entry `rness.json` holds, its optional keys left out when absent. */
function entryOf(
  source: string,
  opts: { path?: string | undefined; ref?: string | undefined },
  commit: string | null,
  hash: string
): SkillEntry {
  return {
    source,
    ...(opts.path === undefined ? {} : { path: opts.path }),
    ...(opts.ref === undefined ? {} : { ref: opts.ref }),
    ...(commit === null ? {} : { commit }),
    hash,
  }
}

const isPathSource = (source: string): boolean => source.startsWith('path:')

/** `source@ref`, the ref as given or the commit's first 7 characters; the source alone for `path:`. */
const versionOf = (
  source: string,
  ref: string | undefined,
  commit: string | null | undefined
): string =>
  isPathSource(source)
    ? source
    : `${source}@${ref ?? commit?.slice(0, 7) ?? 'HEAD'}`

const kilobytes = (bytes: number): string =>
  `${Math.max(1, Math.ceil(bytes / 1024))} KB`

const plural = (n: number, one: string): string =>
  `${n} ${one}${n === 1 ? '' : 's'}`

/** Run `work` as a command: a refusal or failure is the one line of `reportError`, exit 1. */
async function run(
  title: string,
  opts: SkillOptions,
  deps: Partial<CommandDeps>,
  work: (c: Context) => Promise<number>
): Promise<number> {
  try {
    const c = await openContext(opts, deps)
    c.ui.intro(title)
    const code = await work(c)
    c.ui.outro(code === 0 ? 'Done' : 'Failed', code === 0 ? 'done' : 'error')
    return code
  } catch (e) {
    return reportError(e)
  }
}

/**
 * `rness skill add <source>`: fetch, check and copy a skill into
 * `.rness/skills/`, then declare it in `rness.json` (spec 0041 §3). Changes
 * `.rness` only; commits nothing.
 */
export async function skillAddCommand(
  source: string,
  opts: SkillOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  return run(
    'Skill add',
    opts,
    deps,
    async ({ ws, manifest, ui, credentialsFor }) => {
      const url = skillSourceUrl(source)
      if (url === null && (opts.path !== undefined || opts.ref !== undefined))
        throw new Refusal(
          "a path: source is the skill's directory itself; --path and --ref apply to a repository source"
        )
      checkScope(manifest, opts.scope)
      const scope = opts.scope ?? null
      const fetched = await fetchSkill(ws.rnessDir, source, {
        ...(opts.path === undefined ? {} : { path: opts.path }),
        ...(opts.ref === undefined ? {} : { ref: opts.ref }),
        credentials: url === null ? null : await credentialsFor(url),
      })
      try {
        const name = opts.name ?? fetched.name
        if (Object.hasOwn(levelSkills(manifest, scope), name))
          throw new Refusal(
            `skill "${name}" is already declared at ${keyPath(manifest, scope, name)}: run rness skill update ${name}`
          )
        const current = await teamSkills(ws.rnessDir, manifest)
        const dir = join(
          ws.rnessDir,
          'skills',
          ...(scope === null ? [] : ['scopes', scope]),
          name
        )
        if (
          await lstat(dir).then(
            () => true,
            () => false
          )
        )
          throw new Refusal(
            `skill "${name}": ${copyPath(ws, { dir })} already exists, a skill written by the team; remove it or pick another name with --name`
          )
        const prospective: TeamSkill = {
          name,
          scope,
          dir,
          entry: { source, hash: '' },
        }
        const clash = skillConflicts(ws.rnessDir, manifest, [
          ...current,
          prospective,
        ]).filter((line) => line.startsWith(`skill "${name}" is `))
        if (clash.length > 0) throw new Refusal(clash.join('\n'))

        const copied = await copySkill(ws.rnessDir, fetched, {
          scope,
          ...(opts.name === undefined ? {} : { name: opts.name }),
        })
        const files = (await skillFileDigests(copied.dir)).size
        await writeManifest(
          ws.rnessDir,
          withEntry(
            manifest,
            scope,
            copied.name,
            entryOf(source, opts, fetched.commit, copied.hash)
          )
        )
        ui.line(
          'added',
          `skill ${copied.name} (${versionOf(source, opts.ref, fetched.commit)}, ${plural(files, 'file')}, ${kilobytes(copied.bytes)})`
        )
        ui.line(
          'wrote',
          `${copyPath(ws, copied)}   review it in the pull request`
        )
        ui.line(
          'declared',
          `.rness/rness.json  ${keyPath(manifest, scope, copied.name)}`
        )
        return 0
      } finally {
        await fetched.release()
      }
    }
  )
}

/** Where a declared skill lives. */
interface Place {
  scope: string | null
  entry: SkillEntry
}

const placesOf = (manifest: Manifest, name: string): Place[] => [
  ...(Object.hasOwn(manifest.skills ?? {}, name)
    ? [{ scope: null, entry: (manifest.skills ?? {})[name] as SkillEntry }]
    : []),
  ...Object.entries(manifest.scopes).flatMap(([scope, s]) =>
    Object.hasOwn(s.skills ?? {}, name)
      ? [{ scope, entry: (s.skills ?? {})[name] as SkillEntry }]
      : []
  ),
]

/** The one declaration `name` (and `--scope`) designates; refused when it is none, several, or the team's own. */
function resolveDeclared(
  manifest: Manifest,
  skills: readonly TeamSkill[],
  name: string,
  scope: string | undefined,
  written: (s: TeamSkill) => string
): Place {
  const all = placesOf(manifest, name)
  const places =
    scope === undefined ? all : all.filter((p) => p.scope === scope)
  if (places.length === 1) return places[0] as Place
  if (places.length > 1)
    throw new Refusal(
      `skill "${name}" is declared in more than one place (${places.map((p) => keyPath(manifest, p.scope, name)).join(', ')}): pass --scope`
    )
  if (all.length > 0)
    throw new Refusal(
      `skill "${name}" is not declared in scope "${scope ?? ''}" (declared at ${all.map((p) => keyPath(manifest, p.scope, name)).join(', ')})`
    )
  const own = skills.find(
    (s) =>
      s.entry === null &&
      s.name === name &&
      (scope === undefined || s.scope === scope)
  )
  if (own !== undefined) throw new Refusal(written(own))
  throw new Refusal(`no skill "${name}" is declared in this organization`)
}

/**
 * `rness skill update [names...]`: fetch each declared skill again (at
 * `--ref` when given), replace its copy and say what changed (spec 0041 §3).
 */
export async function skillUpdateCommand(
  names: readonly string[],
  opts: SkillOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  return run(
    'Skill update',
    opts,
    deps,
    async ({ ws, manifest: first, ui, credentialsFor }) => {
      checkScope(first, opts.scope)
      if (opts.ref !== undefined && names.length !== 1)
        throw new Refusal('--ref needs exactly one skill name')
      const skills = await teamSkills(ws.rnessDir, first)
      const targets: (Place & { name: string })[] =
        names.length === 0
          ? skills
              .filter(
                (s) =>
                  s.entry !== null &&
                  (opts.scope === undefined || s.scope === opts.scope)
              )
              .map((s) => ({
                name: s.name,
                scope: s.scope,
                entry: s.entry as SkillEntry,
              }))
          : names.map((name) => ({
              name,
              ...resolveDeclared(
                first,
                skills,
                name,
                opts.scope,
                () => `skill "${name}": written by the team: nothing to update`
              ),
            }))
      if (targets.length === 0) {
        ui.hint('no declared skills to update')
        return 0
      }
      let manifest = first
      let failed = false
      for (const { name, scope, entry } of targets) {
        const key = keyPath(manifest, scope, name)
        try {
          const ref = opts.ref ?? entry.ref
          if (isPathSource(entry.source)) {
            const dir = resolve(ws.rnessDir, entry.source.slice(5))
            if (
              !(await stat(dir).then(
                (s) => s.isDirectory(),
                () => false
              ))
            ) {
              ui.error(
                `skill "${name}": ${entry.source} is not on this machine; only the machine that has it can update it (declared at .rness/rness.json ${key})`
              )
              failed = true
              continue
            }
          }
          const url = skillSourceUrl(entry.source)
          const fetched = await fetchSkill(ws.rnessDir, entry.source, {
            ...(entry.path === undefined ? {} : { path: entry.path }),
            ...(ref === undefined ? {} : { ref }),
            credentials: url === null ? null : await credentialsFor(url),
          })
          try {
            const dir = skills.find(
              (s) => s.name === name && s.scope === scope
            )?.dir
            const before =
              dir === undefined
                ? new Map<string, string>()
                : await skillFileDigests(dir).catch(
                    () => new Map<string, string>()
                  )
            const copied = await copySkill(ws.rnessDir, fetched, {
              scope,
              name,
            })
            const diff = diffSkillFiles(
              before,
              await skillFileDigests(copied.dir)
            )
            manifest = withEntry(
              manifest,
              scope,
              name,
              entryOf(
                entry.source,
                { path: entry.path, ref },
                fetched.commit,
                copied.hash
              )
            )
            await writeManifest(ws.rnessDir, manifest)
            const version = versionOf(entry.source, ref, fetched.commit)
            if (
              diff.added.length + diff.changed.length + diff.removed.length ===
              0
            )
              ui.line('unchanged', `skill ${name} (${version})`)
            else
              ui.line(
                'updated',
                `skill ${name} (${version}: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed)`
              )
          } finally {
            await fetched.release()
          }
        } catch (e) {
          ui.error(e instanceof Error ? e.message : String(e))
          failed = true
        }
      }
      return failed ? 1 : 0
    }
  )
}

/**
 * `rness skill remove <name>`: undeclare a skill and delete its copy; each
 * developer's installed copies go at their next `sync` (spec 0041 §3).
 */
export async function skillRemoveCommand(
  name: string,
  opts: SkillOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  return run('Skill remove', opts, deps, async ({ ws, manifest, ui }) => {
    checkScope(manifest, opts.scope)
    const skills = await teamSkills(ws.rnessDir, manifest)
    const { scope } = resolveDeclared(
      manifest,
      skills,
      name,
      opts.scope,
      (s) =>
        `skill "${name}" is written by the team: its directory ${copyPath(ws, s)} is the team's, delete it in a pull request`
    )
    const copy = skills.find((s) => s.name === name && s.scope === scope)
    const key = keyPath(manifest, scope, name)
    await writeManifest(ws.rnessDir, withoutEntry(manifest, scope, name))
    if (copy !== undefined) await rm(copy.dir, { recursive: true, force: true })
    ui.line('removed', `skill ${name}`)
    if (copy !== undefined) ui.line('deleted', copyPath(ws, copy))
    ui.line('undeclared', `.rness/rness.json  ${key}`)
    return 0
  })
}
