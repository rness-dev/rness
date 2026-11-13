import { lstat, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import type { CommandDeps } from '../core/deps.ts'
import { loadManifest, workspaceName, writeManifest } from '../core/manifest.ts'
import { rnessCommand } from '../core/pm.ts'
import type { GitCredentials } from '../core/provider.ts'
import { openGitProvider } from '../core/providers.ts'
import {
  type AppliedSkill,
  COMMIT_FIRST,
  type Consent,
  type ConsentEntry,
  appliedSkills,
  designated,
  droppedLine,
  isPending,
  isValid,
  originOf,
  readConsent,
  skillLabel,
  versionOf,
  writeConsent,
} from '../core/skill-consent.ts'
import {
  type ProjectOptions,
  type Projection,
  ROOT_LABEL,
  declaredClones,
  projectClone,
  projectRoot,
  updateLines,
} from '../core/skill-install.ts'
import {
  type SkillTree,
  type TeamSkill,
  allowedToolsText,
  copySkill,
  diffSkillFiles,
  fetchSkill,
  fileDigests,
  linkedLevelProblem,
  plainText,
  quoted,
  skillConflictsByName,
  skillSourceUrl,
  teamSkills,
} from '../core/skills.ts'
import { defaultTerminal } from '../core/terminal.ts'
import { hasControl } from '../core/text.ts'
import type { Manifest, SkillEntry, Workspace } from '../core/types.ts'
import { type Ui, makeUi } from '../core/ui.ts'
import { findWorkspace } from '../core/workspace.ts'
import { refreshBlocks } from '../core/write-blocks.ts'
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
  /** `install`: accept without the question (the answer given ahead). */
  yes?: boolean
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

/** Refused before anything is fetched or written: a control character in what git would be given and `rness.json` would hold. */
function checkPlain(options: [string, string | undefined][]): void {
  for (const [label, value] of options)
    if (value !== undefined && hasControl(value))
      throw new Refusal(`${label} ${quoted(value)} holds a control character`)
}

/** The scope `--scope` names: a key of `manifest.scopes`, else refused naming the known ones. */
function checkScope(manifest: Manifest, scope: string | undefined): void {
  if (scope === undefined || Object.hasOwn(manifest.scopes, scope)) return
  const known = Object.keys(manifest.scopes)
  throw new Refusal(
    `unknown scope ${quoted(scope)}${known.length === 0 ? ': this workspace declares none' : `; known scopes: ${plainText(known.join(', '))}`}`
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
  return plainText(
    [...chain.map((s) => `scopes.${s}`), `skills.${name}`].join('.')
  )
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
  tree: string
): SkillEntry {
  return {
    source,
    ...(opts.path === undefined ? {} : { path: opts.path }),
    ...(opts.ref === undefined ? {} : { ref: opts.ref }),
    ...(commit === null ? {} : { commit }),
    tree,
  }
}

const isPathSource = (source: string): boolean => source.startsWith('path:')

const kilobytes = (bytes: number): string =>
  `${Math.max(1, Math.ceil(bytes / 1024))} KB`

const plural = (n: number, one: string): string =>
  `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Bring the generated blocks (the root's and the clones') up to date with
 * the skills just changed, as `sync` writes them: the `.rness` pre-commit
 * hook runs `validate`, which refuses a stale block. Clones nothing, pulls
 * nothing, installs nothing. A failure is said and makes the command fail;
 * the change to `.rness` itself is kept.
 */
async function refresh(
  ws: Workspace,
  ui: Ui,
  manifest: Manifest
): Promise<number> {
  try {
    const { lines, problems } = await refreshBlocks(ws, manifest, (text) =>
      ui.warn(text)
    )
    for (const [verb, rest] of lines) ui.line(verb, rest)
    for (const p of problems) ui.error(p)
    return problems.length > 0 ? 1 : 0
  } catch (e) {
    ui.error(
      `the blocks could not be refreshed: ${e instanceof Error ? e.message : String(e)}; run ${rnessCommand()} sync`
    )
    return 1
  }
}

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
      checkPlain([
        ['source', source],
        ['--path', opts.path],
        ['--ref', opts.ref],
      ])
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
            `skill ${quoted(name)} is already declared at ${keyPath(manifest, scope, name)}: run rness skill update ${plainText(name)}`
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
            `skill ${quoted(name)}: ${plainText(copyPath(ws, { dir }))} already exists, a skill written by the team; remove it or pick another name with --name`
          )
        const prospective: TeamSkill = {
          name,
          scope,
          dir,
          entry: { source, tree: '' },
        }
        const clash = skillConflictsByName(ws.rnessDir, manifest, [
          ...current,
          prospective,
        ]).filter((c) => c.name === name)
        if (clash.length > 0)
          throw new Refusal(clash.map((c) => c.line).join('\n'))

        const copied = await copySkill(ws.rnessDir, fetched, {
          scope,
          ...(opts.name === undefined ? {} : { name: opts.name }),
        })
        const declaredNow = withEntry(
          manifest,
          scope,
          copied.name,
          entryOf(source, opts, fetched.commit, copied.copy.tree)
        )
        try {
          await writeManifest(ws.rnessDir, declaredNow)
        } catch (e) {
          // An undeclared copy would read as a skill the team wrote.
          await rm(copied.dir, { recursive: true, force: true })
          throw e
        }
        ui.line(
          'added',
          `skill ${plainText(copied.name)} (${plainText(versionOf(source, opts.ref, fetched.commit))}, ${plural(copied.copy.files.length, 'file')}, ${kilobytes(copied.copy.bytes)})`
        )
        ui.line(
          'wrote',
          `${plainText(copyPath(ws, copied))}   review it in the pull request`
        )
        ui.line(
          'declared',
          `.rness/rness.json  ${keyPath(manifest, scope, copied.name)} (tree ${copied.copy.tree.slice(0, 7)})`
        )
        return refresh(ws, ui, declaredNow)
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
      `skill ${quoted(name)} is declared in more than one place (${places.map((p) => keyPath(manifest, p.scope, name)).join(', ')}): pass --scope`
    )
  if (all.length > 0)
    throw new Refusal(
      `skill ${quoted(name)} is not declared in scope ${quoted(scope ?? '')} (declared at ${all.map((p) => keyPath(manifest, p.scope, name)).join(', ')})`
    )
  const own = skills.find(
    (s) =>
      s.entry === null &&
      s.name === name &&
      (scope === undefined || s.scope === scope)
  )
  if (own !== undefined) throw new Refusal(written(own))
  throw new Refusal(`no skill ${quoted(name)} is declared in this organization`)
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
      checkPlain([['--ref', opts.ref]])
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
                () =>
                  `skill ${quoted(name)}: written by the team: nothing to update`
              ),
            }))
      if (
        opts.ref !== undefined &&
        targets.some((t) => isPathSource(t.entry.source))
      )
        throw new Refusal(
          "a path: source is the skill's directory itself; --ref applies to a repository source"
        )
      if (targets.length === 0) {
        ui.hint('no declared skills to update')
        return 0
      }
      let manifest = first
      let failed = false
      let changed = false
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
                `skill ${quoted(name)}: ${plainText(entry.source)} is not on this machine; only the machine that has it can update it (declared at .rness/rness.json ${key})`
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
            const copied = await copySkill(ws.rnessDir, fetched, {
              scope,
              name,
            })
            const diff = diffSkillFiles(
              copied.before,
              fileDigests(copied.copy.files)
            )
            manifest = withEntry(
              manifest,
              scope,
              name,
              entryOf(
                entry.source,
                { path: entry.path, ref },
                fetched.commit,
                copied.copy.tree
              )
            )
            await writeManifest(ws.rnessDir, manifest)
            const version = versionOf(entry.source, ref, fetched.commit)
            if (
              diff.added.length + diff.changed.length + diff.removed.length ===
              0
            )
              ui.line(
                'unchanged',
                `skill ${plainText(name)} (${plainText(version)})`
              )
            else {
              changed = true
              ui.line(
                'updated',
                `skill ${plainText(name)} (${plainText(version)}: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed)`
              )
            }
          } finally {
            await fetched.release()
          }
        } catch (e) {
          ui.error(e instanceof Error ? e.message : String(e))
          failed = true
        }
      }
      const refreshed = changed ? await refresh(ws, ui, manifest) : 0
      return failed || refreshed !== 0 ? 1 : 0
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
        `skill ${quoted(name)} is written by the team: its directory ${plainText(copyPath(ws, s))} is the team's, delete it in a pull request`
    )
    // Deleting through a link would delete outside `.rness`: refused before
    // anything is written, as `copySkill` refuses to write through one.
    const linked = await linkedLevelProblem(ws.rnessDir, scope)
    if (linked !== null) throw new Refusal(`skill ${quoted(name)}: ${linked}`)
    const copy = skills.find((s) => s.name === name && s.scope === scope)
    const key = keyPath(manifest, scope, name)
    const without = withoutEntry(manifest, scope, name)
    await writeManifest(ws.rnessDir, without)
    if (copy !== undefined) await rm(copy.dir, { recursive: true, force: true })
    ui.line('removed', `skill ${plainText(name)}`)
    if (copy !== undefined) ui.line('deleted', plainText(copyPath(ws, copy)))
    ui.line('undeclared', `.rness/rness.json  ${key}`)
    return refresh(ws, ui, without)
  })
}

/** The `allowed-tools` the committed `SKILL.md` of a skill asks for, as one line; `none` when it asks for none. */
const allowedToolsOf = (head: SkillTree): string =>
  allowedToolsText(head.fields['allowed-tools']) ?? 'none'

const pad = (cells: readonly string[], widths: readonly number[]): string =>
  cells
    .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
    .join('  ')
    .trimEnd()

const widthsOf = (rows: readonly (readonly string[])[]): number[] =>
  (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)))

/** Print through the terminal sanitizer: skill and manifest values never reach it raw. */
function say(ui: Ui, kind: 'line' | 'hint', ...args: string[]): void {
  const [first = '', second] = args
  if (kind === 'hint') ui.hint(plainText(first))
  else ui.line(first, plainText(second ?? ''))
}

const STATE_WORDS = {
  installed: 'installed',
  declined: 'declined',
  pending: 'pending',
  invalid: 'invalid',
} as const

/**
 * `rness skill install [names...] [--yes]`: show the team skills awaiting
 * the developer and record their answer, once per skill (spec 0041 §5,
 * decision 9), then project the answers into the clones and the root (§6):
 * each skill as committed at `HEAD` of `.rness`.
 */
export async function skillInstallCommand(
  names: readonly string[],
  opts: SkillOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  return run('Skill install', opts, deps, async ({ ws, manifest, ui }) => {
    // An unreadable record hides the earlier answers: the projection that
    // follows then writes the skills answered now and removes nothing.
    let unreadable = false
    const consent = await readConsent(
      ws.rnessDir,
      (file) => {
        unreadable = true
        ui.warn(
          `${file} is unreadable: read as empty, the questions are asked again`
        )
      },
      (file, ids) => ui.warn(droppedLine(file, ids))
    )
    const applied = await appliedSkills(ws, manifest, consent)
    // A name two applied skills share is said, and taken, by its id.
    const label = skillLabel(applied)
    let listed: (AppliedSkill & { head: SkillTree })[]
    // Invalid copies are reported, never offered: validate says what to
    // fix, and a skill not committed yet is installed once it is.
    const skip = (a: AppliedSkill): void =>
      say(
        ui,
        'line',
        'skipped',
        a.uncommitted === true
          ? `${label(a)}: ${COMMIT_FIRST}`
          : `${label(a)}: ${a.problem ?? 'invalid'}; run rness validate`
      )
    let onlyInvalid = false
    // Named and accepted already: projected again below, said `already
    // installed` when nothing had to be written.
    let done: AppliedSkill[] = []
    if (names.length === 0) {
      applied
        .filter((a) => a.state === 'invalid' && a.answer !== 'declined')
        .forEach(skip)
      listed = applied.filter(isValid).filter((a) => isPending(a.state))
    } else {
      const unknown = names.filter((n) => designated(applied, n).length === 0)
      if (unknown.length > 0)
        throw new Refusal(
          `unknown skill ${unknown.map(quoted).join(', ')}; known skills: ${plainText([...new Set(applied.map(label))].join(', ')) || 'none'}`
        )
      // The answer given ahead never covers a skill the developer did not
      // name: a name two skills share is taken by its id only (ruling R27).
      if (opts.yes === true)
        for (const n of names) {
          const several = designated(applied, n)
          if (several.length > 1)
            throw new Refusal(
              `skill ${quoted(n)} names more than one team skill: name one by its id, ${plainText(several.map((a) => a.id).join(' or '))}`
            )
        }
      const chosen = new Set(names.flatMap((n) => designated(applied, n)))
      const named = applied.filter((a) => chosen.has(a))
      done = named.filter((a) => a.state === 'installed')
      named.filter((a) => a.state === 'invalid').forEach(skip)
      onlyInvalid = named.every((a) => a.state === 'invalid')
      listed = named.filter(isValid).filter((a) => a.state !== 'installed')
    }
    const alreadyInstalled = (written: ReadonlySet<string>): void => {
      const left = done.filter((a) => !written.has(a.skill.name))
      if (left.length > 0)
        say(
          ui,
          'line',
          'skills',
          `${left.map(label).join(', ')}: already installed`
        )
    }
    if (listed.length === 0) {
      if (onlyInvalid) return 1
      if (names.length === 0) {
        say(ui, 'line', 'skills', 'no team skill awaits your consent')
        // The accepted skills made true, as sync does (ruling R38): a new
        // version written and said, a missing copy written; nothing removed.
        const accepted = applied.filter((a) => a.state === 'installed')
        if (accepted.length === 0) return 0
        const { ok } = await projectAll(ws, manifest, ui, consent, {
          only: new Set(accepted.map((a) => a.skill.name)),
        })
        return ok ? 0 : 1
      }
      if (done.length > 0) {
        // No question: their copies made true now, as sync would (a copy
        // removed, a clone added since), and said `installed` when written.
        const { ok, written } = await projectAll(ws, manifest, ui, consent, {
          only: new Set(done.map((a) => a.skill.name)),
        })
        alreadyInstalled(written)
        return ok ? 0 : 1
      }
      return 0
    }
    const rows: string[][] = []
    for (const a of listed)
      rows.push([
        label(a),
        a.skill.entry === null
          ? `written by the team (${copyPath(ws, a.skill).replace(/\/$/, '')})`
          : originOf(a.skill),
        kilobytes(a.head.bytes),
        `allowed-tools: ${allowedToolsOf(a.head)}`,
      ])
    const widths = widthsOf(rows)
    const where = workspaceName(manifest, ws.root)
    say(
      ui,
      'line',
      'skills',
      `${plural(listed.length, 'team skill')} for ${where}:`
    )
    for (const row of rows) say(ui, 'hint', `  ${pad(row, widths)}`)

    let answer: 'accepted' | 'declined'
    if (opts.yes === true) answer = 'accepted'
    else if (!(deps.terminal ?? defaultTerminal).isTty()) {
      // A refusal without a TTY exits 2, as the other commands' (README).
      ui.error(
        `answer in a terminal, or run ${rnessCommand()} skill install --yes`
      )
      return 2
    } else {
      const p = await (deps.terminal ?? defaultTerminal).prompts()
      for (;;) {
        const choice = await p.select({
          message: `Install them in the repositories of ${where}?`,
          options: [
            { value: 'install', label: 'Install (y)' },
            { value: 'decline', label: 'Decline (N)' },
            { value: 'details', label: 'Details' },
          ],
          initialValue: 'decline',
        })
        if (p.isCancel(choice)) {
          ui.cancelled()
          return 1
        }
        if (choice === 'details') {
          for (const a of listed) {
            say(ui, 'line', 'skill', label(a))
            say(
              ui,
              'hint',
              `  ${String(a.head.fields['description'] ?? '').trim()}`
            )
            for (const f of a.head.files)
              say(ui, 'hint', `  ${f.path}  ${kilobytes(f.size)}`)
          }
          continue
        }
        answer = choice === 'install' ? 'accepted' : 'declined'
        break
      }
    }
    const date = new Date(deps.now?.() ?? Date.now()).toISOString().slice(0, 10)
    const skills = { ...consent.skills }
    // One answer per skill: its new versions need none (decision 9). The
    // tree accepted is kept for information.
    for (const a of listed)
      skills[a.id] = {
        answer,
        date,
        ...(answer === 'accepted' ? { tree: a.head.tree } : {}),
      } satisfies ConsentEntry
    await writeConsent(ws.rnessDir, { version: 1, skills })
    const labels = listed.map(label)
    const said = labels.join(', ')
    if (answer === 'accepted') say(ui, 'line', 'accepted', said)
    else {
      // The form install takes back: the name, or the id it was said by.
      const forms = [
        ...new Set(
          labels.map((l) => (l.includes('/') ? '<scope>/<name>' : '<name>'))
        ),
      ].sort()
      say(
        ui,
        'line',
        'declined',
        `${said}   (rness skill install ${forms.join(' or ')} installs one later)`
      )
    }
    // The answers made true on disk (spec 0041 §6): an accepted skill written,
    // a declined one removed, in every clone and at the root.
    const only = unreadable
      ? { only: new Set(listed.map((a) => a.skill.name)) }
      : {}
    const { ok, written } = await projectAll(
      ws,
      manifest,
      ui,
      { version: 1, skills },
      only
    )
    alreadyInstalled(written)
    return ok ? 0 : 1
  })
}

/**
 * Run the projection of the accepted skills over the declared clones and
 * the root. `opts` limits it (`ProjectOptions`). A place that fails is
 * kept, its error escaped, and the others are still projected, as `sync`
 * does.
 */
async function projectPlaces(
  ws: Workspace,
  manifest: Manifest,
  consent: Consent,
  opts: ProjectOptions
): Promise<{
  applied: AppliedSkill[]
  places: [string, Projection][]
  failed: string[]
}> {
  const applied = await appliedSkills(ws, manifest, consent)
  const places: [string, Projection][] = []
  const failed: string[] = []
  const project = async (
    label: string,
    work: () => Promise<Projection>
  ): Promise<void> => {
    try {
      places.push([label, await work()])
    } catch (e) {
      failed.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const repo of await declaredClones(ws, manifest))
    await project(`org/${repo}`, () =>
      projectClone(ws, manifest, applied, repo, opts)
    )
  await project(ROOT_LABEL, () => projectRoot(ws, manifest, applied, opts))
  return { applied, places, failed }
}

/** The notes of `places`, then their problems and `failed`, said; true when there was none. */
function sayPlaces(
  ui: Ui,
  places: readonly [string, Projection][],
  failed: readonly string[]
): boolean {
  for (const [, p] of places) for (const n of p.notes) say(ui, 'hint', n)
  const problems = [...places.flatMap(([, p]) => p.problems), ...failed]
  for (const line of problems) ui.error(plainText(line))
  return problems.length === 0
}

/**
 * Run the projection (`projectPlaces`) and say it: `installed <names>
 * (<places>)`, each new version `updated`, what was removed, then each
 * clash. `ok` false when a place failed; `written`: the names installed,
 * updated or rewritten somewhere.
 */
async function projectAll(
  ws: Workspace,
  manifest: Manifest,
  ui: Ui,
  consent: Consent,
  opts: ProjectOptions
): Promise<{ ok: boolean; written: Set<string> }> {
  const { applied, places, failed } = await projectPlaces(
    ws,
    manifest,
    consent,
    opts
  )
  const summary = (verb: string, of: (p: Projection) => string[]): void => {
    const done = places.filter(([, p]) => of(p).length > 0)
    if (done.length === 0) return
    const names = [...new Set(done.flatMap(([, p]) => of(p)))].sort()
    say(
      ui,
      'line',
      verb,
      `${names.join(', ')}   (${done.map(([l]) => l).join(', ')})`
    )
  }
  summary('installed', (p) => [...p.installed, ...p.rewritten])
  for (const [verb, rest] of updateLines(
    places.map(([, p]) => p),
    applied
  ))
    say(ui, 'line', verb, rest)
  summary('removed', (p) => p.removed)
  return {
    ok: sayPlaces(ui, places, failed),
    written: new Set(
      places.flatMap(([, p]) => [
        ...p.installed,
        ...p.rewritten,
        ...p.updated.map((u) => u.name),
      ])
    ),
  }
}

/**
 * `rness skill decline <names...>`: record the developer's no for these
 * team skills, accepted or not (ruling R36), then remove their installed
 * copies from every clone and the root, and nothing else. A name two
 * applied skills share is refused, naming their ids (ruling R27); `install
 * <name>` brings one back.
 */
export async function skillDeclineCommand(
  names: readonly string[],
  opts: SkillOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  return run('Skill decline', opts, deps, async ({ ws, manifest, ui }) => {
    const consent = await readConsent(
      ws.rnessDir,
      (file) => ui.warn(`${file} is unreadable: read as empty`),
      (file, ids) => ui.warn(droppedLine(file, ids))
    )
    const applied = await appliedSkills(ws, manifest, consent)
    const label = skillLabel(applied)
    const unknown = names.filter((n) => designated(applied, n).length === 0)
    if (unknown.length > 0)
      throw new Refusal(
        `unknown skill ${unknown.map(quoted).join(', ')}; known skills: ${plainText([...new Set(applied.map(label))].join(', ')) || 'none'}`
      )
    for (const n of names) {
      const several = designated(applied, n)
      if (several.length > 1)
        throw new Refusal(
          `skill ${quoted(n)} names more than one team skill: name one by its id, ${plainText(several.map((a) => a.id).join(' or '))}`
        )
    }
    const chosen = new Set(names.flatMap((n) => designated(applied, n)))
    const declined = applied.filter((a) => chosen.has(a))
    const date = new Date(deps.now?.() ?? Date.now()).toISOString().slice(0, 10)
    const skills = { ...consent.skills }
    for (const a of declined)
      skills[a.id] = { answer: 'declined', date } satisfies ConsentEntry
    const answered: Consent = { version: 1, skills }
    await writeConsent(ws.rnessDir, answered)
    // Those names only, their copies removed where they are declined now.
    const { places, failed } = await projectPlaces(ws, manifest, answered, {
      only: new Set(declined.map((a) => a.skill.name)),
      remove: true,
    })
    const from = places.filter(([, p]) => p.removed.length > 0)
    say(
      ui,
      'line',
      'declined',
      `${declined.map(label).join(', ')}${from.length === 0 ? '' : `   removed (${from.map(([l]) => l).join(', ')})`}`
    )
    return sayPlaces(ui, places, failed) ? 0 : 1
  })
}

/** `rness skill list`: every team skill that applies to this workspace, with its state for the developer. */
export async function skillListCommand(
  opts: SkillOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  return run('Skill list', opts, deps, async ({ ws, manifest, ui }) => {
    const consent = await readConsent(
      ws.rnessDir,
      (file) => ui.warn(`${file} is unreadable: read as empty`),
      (file, ids) => ui.warn(droppedLine(file, ids))
    )
    const applied = await appliedSkills(ws, manifest, consent)
    if (applied.length === 0) {
      say(ui, 'line', 'skills', 'no team skill in rness.json or .rness/skills')
      return 0
    }
    const rows = applied.map((a) => [
      a.skill.name,
      a.skill.scope ?? 'all',
      originOf(a.skill),
      a.state === 'invalid'
        ? `invalid: ${a.problem ?? ''}`
        : STATE_WORDS[a.state],
    ])
    const widths = widthsOf(rows)
    for (const row of rows) say(ui, 'hint', pad(row, widths))
    return 0
  })
}
