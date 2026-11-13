import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  agentTargets,
  leftoverTargets,
  writtenFiles,
} from '../core/agent-targets.ts'
import {
  SUPPORTED_AGENTS,
  unsupportedAgents,
  unsupportedMessage,
} from '../core/agents.ts'
import { askAgents } from '../core/ask-agents.ts'
import { migrateBoards } from '../core/board-migration.ts'
import type { CommandDeps } from '../core/deps.ts'
import { exists, readOrNull, writeFileAtomic } from '../core/fs.ts'
import {
  HOOK_NAMES,
  hookManagerSnippet,
  installHooks,
} from '../core/git-hooks.ts'
import { clone, gitPath, isClean, pullFastForward } from '../core/git.ts'
import {
  NAME,
  NAME_RULE,
  loadManifest,
  providerOf,
  repositories,
  workspaceName,
  writeManifest,
} from '../core/manifest.ts'
import { rnessCommand } from '../core/pm.ts'
import type { GitCredentials } from '../core/provider.ts'
import { openGitProvider } from '../core/providers.ts'
import { pruneRefusals } from '../core/refusals.ts'
import { pendingCount } from '../core/skill-consent.ts'
import {
  ROOT_LABEL,
  pendingLine,
  projectClone,
  projectRoot,
  projectionLines,
  skillsOfRun,
} from '../core/skill-install.ts'
import { count } from '../core/style.ts'
import { type Terminal, defaultTerminal } from '../core/terminal.ts'
import {
  CHECKING,
  INSTEAD_OF_LINES,
  defaultTransport,
  isSshUrl,
  passphraseHint,
  sshWorkspaceLines,
  testGithubSsh,
} from '../core/transport.ts'
import type { Manifest } from '../core/types.ts'
import { type Line, type Ui, makeUi, plainUi } from '../core/ui.ts'
import { findWorkspace, orgDirs } from '../core/workspace.ts'
import { writeBlocks } from '../core/write-blocks.ts'
import { reportError } from '../report.ts'

export interface SyncOptions {
  /** Only this scope's block (the root block is skipped). */
  scope?: string
  /** Render and compare; write nothing; exit 1 when any block differs. */
  check?: boolean
  /** `git pull --ff-only` in every clean clone. */
  pull?: boolean
  /** Clone every catalogue repository missing from `org/`; by default none is cloned. */
  all?: boolean
  /** Skip the confirmation prompt. */
  yes?: boolean
  /** Agents to declare in rness.json before compiling them (spec 0011 §3.2). */
  agent?: string[]
  /** Internal (tests): directory to resolve from; default `process.cwd()`. */
  cwd?: string
}

/** The picker's "select all" entry; no repository name can take this value. */
const SELECT_ALL = '*'

/** The directories under `org/` — the user's workspace (ADR 0008). */
/**
 * In a terminal: offer the catalogue repositories that are not cloned, or
 * confirm when there are none. Returns the repositories to clone, or an exit
 * code when the run stops here.
 */
async function askWhatToSync(input: {
  org: string
  missing: readonly string[]
  offer: boolean
  terminal: Terminal
  ui: Ui
}): Promise<string[] | number> {
  if (!input.terminal.isTty()) {
    process.stderr.write(
      'rness sync writes files; pass --yes to run without a prompt\n'
    )
    return 2
  }
  const p = await input.terminal.prompts()
  const cancelled = (): number => {
    input.ui.cancelled()
    return 1
  }
  if (input.offer && input.missing.length > 0) {
    const answer = await p.autocompleteMultiselect({
      message: 'Do you want to sync as well?',
      options: [
        {
          value: SELECT_ALL,
          label: 'Select all',
          hint: `${count(input.missing.length, ['repository', 'repositories'])} from rness.json`,
        },
        ...input.missing.map((name) => ({ value: name, label: name })),
      ],
      required: false,
      placeholder: 'Type to filter',
    })
    if (p.isCancel(answer) || !Array.isArray(answer)) return cancelled()
    return answer.includes(SELECT_ALL)
      ? [...input.missing]
      : answer.filter((name) => name !== SELECT_ALL)
  }
  const ok = await p.confirm({
    message: `Sync workspace \`${input.org}\`: rewrite the rness blocks of your clones?`,
  })
  if (p.isCancel(ok) || ok !== true) return cancelled()
  return []
}

/**
 * Why `sync` does not read `org/<dir>`, and what to do about it: a name in
 * another case is one `rness add` renames, unless the lowercase directory is
 * there too; a directory left by an interrupted rename goes back; anything
 * else is no repository name.
 */
function unreadWhy(dir: string, clones: ReadonlySet<string>): string {
  const lower = dir.toLowerCase()
  const step = /^(.+)\.rness-rename$/.exec(dir)
  if (step !== null)
    return `left by an interrupted rename: move it back to org/${step[1]}`
  if (!NAME.test(lower)) return `not a repository name: ${NAME_RULE}`
  if (clones.has(lower))
    return `names are lowercase, and org/${lower} is another directory`
  return `names are lowercase: ${rnessCommand()} add ${lower} renames it org/${lower}`
}

/**
 * The clones whose hooks are written: the repositories `rness.json` declares
 * (the scopes with a `url`, spec 0038 §9), or the one owning `--scope`. A
 * part gets none of its own: its repository's apply. An undeclared clone
 * gets none: no policy applies there, and its hooks would only say so on
 * every commit.
 */
function hookClones(
  manifest: Manifest,
  only: string | undefined,
  clones: readonly string[]
): string[] {
  if (only === undefined) {
    const declared = new Set(repositories(manifest).map((r) => r.name))
    return [...new Set(clones.filter((n) => declared.has(n)))]
  }
  const entry = Object.hasOwn(manifest.scopes, only)
    ? manifest.scopes[only]
    : undefined
  const owner = entry?.path.split('/')[1]?.toLowerCase()
  return owner !== undefined && clones.includes(owner) ? [owner] : []
}

/** Where `sync` remembers what it said about a clone it left alone. */
const HOOKS_NOTICE = 'rness/hooks-notice'

/** The lines to add to a hook, indented as a block under the line that says why. */
const SNIPPET = hookManagerSnippet('<hook>')
  .trimEnd()
  .split('\n')
  .map((l) => `    ${l}`)
  .join('\n')

/** Install the hooks in `dir`; one line per cause worth saying, and the lines to add. */
async function hookLines(
  dir: string,
  label: string,
  ws: string
): Promise<(Line | string)[]> {
  const result = await installHooks(dir, ws)
  const lines: (Line | string)[] = []
  if (result.written.length > 0)
    lines.push(['updated', `${label} git hooks (${result.written.join(', ')})`])
  // A clone left alone stays so (often by the user's global git config): the
  // cause is said once, and again only when it changes.
  const cause =
    result.hooksPath !== null
      ? `hooksPath ${result.hooksPath}`
      : result.foreign.length > 0
        ? `foreign ${result.foreign.join(',')}`
        : null
  const notice = await gitPath(dir, HOOKS_NOTICE)
  if (notice !== null) {
    const said = await readOrNull(notice)
    if (cause === null) {
      if (said !== null) await rm(notice, { force: true })
    } else if (said !== cause) {
      await mkdir(dirname(notice), { recursive: true })
      await writeFileAtomic(notice, cause)
    }
    if (cause === null || said === cause) return lines
  }
  if (result.hooksPath !== null)
    lines.push(
      [
        'skipped',
        `${label} git hooks (core.hooksPath is set, left as is; to check policies there, add to your hook manager's ${HOOK_NAMES.join(', ')} these lines, <hook> its name)`,
      ],
      SNIPPET
    )
  else if (result.foreign.length > 0)
    lines.push(
      [
        'skipped',
        `${label} git hooks ${result.foreign.join(', ')} (not written by rness, left as is; to check policies there, add to it these lines, <hook> its name)`,
      ],
      SNIPPET
    )
  return lines
}

/**
 * `rness sync`: write the blocks of the repositories cloned in `org/` (spec
 * 0003 §4). The clones are the workspace; `rness.json` is the organization's
 * catalogue, so a catalogue repository that is not cloned is offered (in a
 * terminal) or named, never cloned silently — `--all` clones them all.
 * Returns the exit code.
 */
export async function syncCommand(
  given: SyncOptions,
  deps: Partial<CommandDeps> = {}
): Promise<number> {
  // Scope names are lowercase (`NAME`): `--scope Web` is scope `web`.
  const opts: SyncOptions =
    given.scope === undefined
      ? given
      : { ...given, scope: given.scope.toLowerCase() }
  const terminal = deps.terminal ?? defaultTerminal
  const transport = deps.transport ?? defaultTransport
  // Only a clone or a pull needs it, and it reads the stored login.
  let provider = deps.provider
  const credentialsFor = async (
    manifest: Manifest,
    url: string
  ): Promise<GitCredentials | null> =>
    (provider ??=
      (await openGitProvider(manifest)) ?? undefined)?.credentialsFor(url) ??
    null
  const cwd = opts.cwd ?? process.cwd()
  const check = opts.check === true
  // Inside another command's session (`add`, `create`) its reporter is used;
  // on its own, a sync that asks questions is a session of its own.
  const ownUi = deps.ui === undefined
  const ui =
    deps.ui ??
    (opts.yes !== true && !check ? await makeUi(terminal) : { ...plainUi })
  const agentFlags = opts.agent ?? []
  if (agentFlags.length > 0 && check) {
    process.stderr.write(
      '--agent cannot be combined with --check: it declares agents in rness.json\n'
    )
    return 2
  }
  const unknown = unsupportedAgents(agentFlags)[0]
  if (unknown !== undefined) {
    process.stderr.write(
      `unknown agent "${unknown}" (supported: ${SUPPORTED_AGENTS.join(', ')})\n`
    )
    return 2
  }
  try {
    const ws = await findWorkspace(cwd)
    const manifest = await loadManifest(ws.rnessDir)
    const org = workspaceName(manifest, ws.root)
    // An agent this copy cannot compile would leave the team's files half
    // made: refuse before anything is written (spec 0011 §3.1).
    const unsupported = unsupportedAgents(manifest.agents ?? [])[0]
    if (unsupported !== undefined) {
      process.stderr.write(`${unsupportedMessage(unsupported)}\n`)
      return 1
    }
    if (ownUi) ui.intro(`Sync workspace ${org}`)
    if (
      opts.scope !== undefined &&
      !Object.hasOwn(manifest.scopes, opts.scope)
    ) {
      process.stderr.write(`unknown scope: ${opts.scope}\n`)
      return 1
    }

    // The team's agents: named on the command line, or asked once in a
    // terminal; never asked by --yes, --check or --scope (spec 0011 §3.2).
    let declare: string[] | null = null
    if (agentFlags.length > 0) {
      const current = manifest.agents ?? []
      const added = agentFlags.filter((a) => !current.includes(a))
      if (added.length > 0) declare = [...current, ...new Set(added)]
    } else if (
      manifest.agents === null &&
      !check &&
      opts.yes !== true &&
      opts.scope === undefined &&
      terminal.isTty()
    ) {
      const answer = await askAgents(await terminal.prompts())
      if (answer === null) {
        ui.cancelled()
        return 1
      }
      declare = answer
    }
    if (declare !== null) {
      const before = manifest.agents ?? []
      manifest.agents = declare
      await writeManifest(ws.rnessDir, manifest)
      for (const name of declare.filter((a) => !before.includes(a)))
        ui.line('declared', `agent ${name} in .rness/rness.json`)
      if (declare.length === 0)
        ui.line('declared', 'no agent in .rness/rness.json')
      ui.hint('rness.json changed: commit it in .rness, for the whole team')
    }

    // The boards (plan 0045): a number written whole, a README's
    // declarations moved, a newer preset merged. Workspace-wide: not for
    // one scope, never under --check. An upgrade commits what this writes.
    if (!check && opts.scope === undefined) {
      const boards = await migrateBoards(ws.rnessDir, manifest)
      if (boards.changed) {
        manifest.boards = boards.boards
        await writeManifest(ws.rnessDir, manifest)
        for (const [rel, text] of boards.readmes)
          await writeFileAtomic(join(ws.rnessDir, ...rel.split('/')), text)
      }
      for (const [verb, rest] of boards.lines) ui.line(verb, rest)
      if (boards.changed)
        ui.hint('rness.json changed: commit it in .rness, for the whole team')
    }

    const { clones, unread } = await orgDirs(ws.root, providerOf(manifest))
    const repos = repositories(manifest)
    const declared = new Set(repos.map((r) => r.name))
    // A declared repository whose directory differs only by case (`org/dApp`
    // for `dapp`) is not missing: cloning `org/dapp` would fail where the file
    // system ignores case and make a second copy where it does not. It gets
    // its `not read:` line and no block until `rness add` renames it.
    const misnamed = new Set(
      unread
        .map((d) => d.toLowerCase())
        .filter((n) => declared.has(n) && !clones.has(n))
    )
    const missing = repos
      .map((r) => r.name)
      .filter((n) => !clones.has(n) && !misnamed.has(n))
    let toClone = new Set<string>(opts.all === true && !check ? missing : [])
    if (!check && opts.yes !== true) {
      const answer = await askWhatToSync({
        org,
        missing,
        // `--all` already answers; `--scope` is about one block, not the workspace.
        offer: opts.all !== true && opts.scope === undefined,
        terminal,
        ui,
      })
      if (typeof answer === 'number') return answer
      if (opts.all !== true) toClone = new Set(answer)
    }

    // rness.json is authoritative: a git@ entry is cloned over SSH or not at
    // all. Without SSH access, stop before the first clone (spec 0005 §3).
    const overSsh = repos.some(
      (repo) => toClone.has(repo.name) && isSshUrl(repo.url, transport.hosts)
    )
    // Only a clone over SSH can make git ask something on the terminal.
    if (!overSsh) ui.gitIsSilent = true
    if (overSsh) {
      const interactive = opts.yes !== true && terminal.isTty()
      const { access, unattended } = await testGithubSsh(
        transport,
        interactive,
        () => ui.line(...CHECKING)
      )
      if (unattended) ui.gitIsSilent = true
      else if (access.ok) ui.hint(passphraseHint(), 'stderr')
      if (!access.ok) {
        process.stderr.write(
          `${[...sshWorkspaceLines(access.reason), ...INSTEAD_OF_LINES].join('\n')}\n`
        )
        return 1
      }
    }

    // A status line as `[verb, rest]`, or a sentence; said once the pass ends.
    const lines: (Line | string)[] = []
    const problems: string[] = []

    try {
      // 1. Repositories: clone only what was asked for; pull only on request,
      // only clean trees.
      const notCloned = new Set<string>()
      const clonedNow = new Set<string>()
      for (const repo of repos) {
        const { name } = repo
        if (misnamed.has(name)) continue
        const dir = join(ws.root, ...repo.dir.split('/'))
        const label = repo.dir
        if (!(await exists(dir))) {
          if (!toClone.has(name)) {
            notCloned.add(name)
            continue
          }
          try {
            const credentials = await credentialsFor(manifest, repo.url)
            await ui.step({ doing: `cloning  ${label}`, git: true }, () =>
              clone(repo.url, dir, credentials)
            )
            clonedNow.add(name)
            lines.push(['cloned', `${label}`])
          } catch (e) {
            problems.push(
              `${label}: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        } else if (opts.pull === true && !check) {
          try {
            // The files sync writes itself are not the developer's changes:
            // the blocks, and the declared agents' files (spec 0011 §3.3). A
            // user's uncommitted edit to a tracked AGENTS.md is therefore not
            // a veto — git pull --ff-only still refuses to overwrite it and
            // that surfaces as a problem.
            if (!(await isClean(dir, writtenFiles(manifest)))) {
              lines.push(['skipped', `${label} (working tree not clean)`])
              continue
            }
            const credentials = await credentialsFor(manifest, repo.url)
            await ui.step({ doing: `pulling  ${label}`, git: true }, () =>
              pullFastForward(dir, credentials)
            )
            lines.push(['pulled', `${label}`])
          } catch (e) {
            problems.push(
              `${label}: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }
      }

      if (notCloned.size > 0)
        lines.push(
          `not cloned: ${[...notCloned].join(', ')} (${rnessCommand()} add <name>, or ${rnessCommand()} sync --all)`
        )
      // A clone the catalogue does not know gets no block: no scope declares
      // its rules. Say how to bring it in rather than skipping it silently.
      // Every scope is a repository or a part of one (ADR 0012): the
      // repositories name every declared clone.
      const undeclared = [...clones].filter((n) => !declared.has(n))
      if (undeclared.length > 0)
        lines.push(
          `not in rness.json: ${undeclared.join(', ')} (${rnessCommand()} add <name> declares it)`
        )
      // A directory that is no name rness.json can hold is no clone: said,
      // since `rness add` takes a name in any case and renames the directory.
      for (const d of unread)
        lines.push(`not read: org/${d} (${unreadWhy(d, clones)})`)

      // 2. Blocks — only where repositories live; a standalone context checkout has no org/.
      if (!(await exists(join(ws.root, 'org')))) {
        lines.push(['skipped', 'blocks (no org/ directory here)'])
      } else {
        const written = await writeBlocks({
          ws,
          manifest,
          org,
          scope: opts.scope,
          check,
          misnamed,
          notCloned,
          warn: (text) => ui.warn(text),
        })
        lines.push(...written.lines)
        problems.push(...written.problems)
        const { differences } = written
        if (check && differences > 0)
          problems.push(
            `${differences} block(s) out of date: run ${rnessCommand()} sync`
          )

        // 3. Agent targets — the whole workspace, so never under --scope.
        if (opts.scope === undefined) {
          let stale = 0
          for (const o of await agentTargets(ws.root, manifest, { check })) {
            if (o.status === 'invalid')
              problems.push(
                `${o.label}: ${o.detail ?? 'unreadable'}; fix it, then ${rnessCommand()} sync`
              )
            else if (o.status === 'stale') {
              stale += 1
              lines.push(['stale', `${o.label} (${o.detail ?? ''})`])
            } else lines.push([o.status, o.label])
          }
          if (stale > 0)
            problems.push(
              `${stale} agent file(s) out of date: run ${rnessCommand()} sync`
            )
          if (!check)
            for (const label of await leftoverTargets(ws.root, manifest))
              lines.push(
                `${label} still carries the values of an agent no longer in rness.json (left as is)`
              )
        }
      }

      // The team skills of the workspace, with the developer's answers (spec
      // 0041 §5): read under --check too, for the line of those awaiting one.
      let skills: Awaited<ReturnType<typeof skillsOfRun>> | null = null
      try {
        skills = await skillsOfRun(ws, manifest, (text) => ui.warn(text))
      } catch (e) {
        problems.push(
          `team skills: ${e instanceof Error ? e.message : String(e)}`
        )
      }
      /** Write the accepted skills into one place (spec 0041 §6); what it says, said. */
      const project = async (
        label: string,
        work: () => ReturnType<typeof projectClone>
      ): Promise<void> => {
        try {
          const p = await work()
          lines.push(...projectionLines(label, p))
          problems.push(...p.problems)
        } catch (e) {
          problems.push(
            `${label}: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
      const projecting = skills !== null && skills.act && !check

      // 4. The git hooks of the policies, the refusal records, and the team
      // skills accepted, in every declared clone of the selection: never
      // `.rness`, never under --check.
      if (!check && (await exists(join(ws.root, 'org')))) {
        for (const name of hookClones(manifest, opts.scope, [
          ...clones,
          ...clonedNow,
        ])) {
          if (misnamed.has(name)) continue
          const dir = join(ws.root, 'org', name)
          if (!(await exists(dir))) continue
          const label = `org/${name}`
          try {
            lines.push(...(await hookLines(dir, label, ws.root)))
          } catch (e) {
            problems.push(
              `${label}: ${e instanceof Error ? e.message : String(e)}`
            )
          }
          // Independent of the hooks: an error above must not skip it.
          await pruneRefusals(dir)
          if (projecting && skills !== null) {
            const { applied } = skills
            await project(label, () =>
              projectClone(ws, manifest, applied, name)
            )
          }
        }
      }
      // The top-level skills at the root, for a session opened there: the
      // whole workspace, so never under --scope.
      if (projecting && skills !== null && opts.scope === undefined) {
        const { applied } = skills
        await project(ROOT_LABEL, () => projectRoot(ws, manifest, applied))
      }
      // Never a failure: `sync --check` keeps its exit code (spec 0041 §9).
      const pending = skills === null ? 0 : pendingCount(skills.applied)
      if (pending > 0) lines.push(pendingLine(pending))
      // `.rness` gets no hook from sync, but the guard and its own
      // `.githooks/` record there too.
      if (!check) await pruneRefusals(ws.rnessDir)

      return problems.length > 0 ? 1 : 0
    } finally {
      // Both flushes run even when something above throws, and stdout precedes
      // stderr so the report reads in order. The exit code above is computed
      // before this block, so it is unaffected.
      for (const l of lines)
        if (typeof l === 'string') ui.hint(l)
        else ui.line(l[0], l[1])
      for (const p of problems) ui.error(p)
      if (ownUi)
        ui.outro(
          problems.length > 0
            ? 'Done, with problems'
            : check
              ? 'Checked'
              : 'Your clones carry the current context',
          problems.length > 0 ? 'warn' : 'done'
        )
    }
  } catch (e) {
    return reportError(e)
  }
}
