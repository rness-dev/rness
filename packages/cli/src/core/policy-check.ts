import { ownedWhole } from './edit-guard.ts'
import { findBlock } from './merge.ts'
import {
  NON_FAST_FORWARD,
  PATTERN_FLAGS,
  type Policy,
  type PolicyRule,
} from './policy.ts'

/**
 * The policy checker (spec 0040 §3 and §5), pure: text and answers in,
 * failures out. The git hooks (`rness policy check`) and the Claude Code
 * guard are its two callers; they read git and the disk, this decides.
 * Callers pass only the `Enabled` policies that apply.
 */

/** One rule a policy's author wrote, broken once at one place. */
export interface PolicyFailure {
  readonly policy: Policy
  readonly rule: PolicyRule
  /** `commit message, line 7`, `src/a.ts:12`, or the ref of a push. */
  readonly where: string
  /** The offending line, whole: `refusalText` cuts it. */
  readonly line: string
  /** Replaces `rule.fix` when the failure has a better one to give. */
  readonly fix?: string
}

/** A file's change: the lines it adds, and its text once the change is made. */
export interface AddedLinesFile {
  /** Workspace-relative, POSIX. */
  readonly path: string
  /** Line numbers (1-based) in `after`. */
  readonly added: readonly { readonly line: number; readonly text: string }[]
  /** The file after the change: where a rness block is found. */
  readonly after: string
}

export interface PushUpdate {
  readonly ref: string
  readonly localOid: string
  readonly remoteOid: string
}

/**
 * `git merge-base --is-ancestor <remote> <local>`: exit 0 is `ancestor`,
 * 1 is `not-ancestor`, 128 is `missing`, the remote object not being here.
 */
export type Ancestry = 'ancestor' | 'not-ancestor' | 'missing'

const ZEROS = /^0+$/
/** git's scissors line: the comment character, then `>8` between dashes. */
const SCISSORS = /^\S+ -{24} >8 -{24}$/
const LINE_CUT = 120

function violates(rule: PolicyRule, text: string): boolean {
  return new RegExp(rule.deny, PATTERN_FLAGS).test(text)
}

/** Every line of the message up to git's scissors line, comment lines included. */
export function checkCommitMessage(
  text: string,
  policies: readonly Policy[]
): PolicyFailure[] {
  const lines = text.split(/\r\n|\r|\n/)
  const scissors = lines.findIndex((l) => SCISSORS.test(l.trimEnd()))
  const kept = scissors === -1 ? lines : lines.slice(0, scissors)
  const failures: PolicyFailure[] = []
  kept.forEach((line, i) => {
    for (const policy of policies)
      for (const rule of policy.rules)
        if (rule.check === 'commit-message' && violates(rule, line))
          failures.push({
            policy,
            rule,
            where: `commit message, line ${i + 1}`,
            line,
          })
  })
  return failures
}

/**
 * The lines a change adds. rness's own outputs are exempt: a file written
 * whole by sync (`ownedWhole`) and the lines inside a rness block.
 */
export function checkAddedLines(
  files: readonly AddedLinesFile[],
  policiesOf: (path: string) => readonly Policy[]
): PolicyFailure[] {
  const failures: PolicyFailure[] = []
  for (const file of files) {
    if (ownedWhole(file.path)) continue
    const policies = policiesOf(file.path)
    if (policies.length === 0) continue
    const found = findBlock(file.after.split(/\r\n|\r|\n/))
    // Line numbers are 1-based, the span's indexes 0-based and inclusive.
    const inBlock = (n: number): boolean =>
      found.kind === 'one' && n >= found.begin + 1 && n <= found.end + 1
    for (const { line, text } of file.added) {
      if (inBlock(line)) continue
      for (const policy of policies)
        for (const rule of policy.rules)
          if (rule.check === 'added-lines' && violates(rule, text))
            failures.push({
              policy,
              rule,
              where: `${file.path}:${line}`,
              line: text,
            })
    }
  }
  return failures
}

const short = (oid: string): string => oid.slice(0, 7)

/**
 * A new branch (remote all zeros) and a deletion (local all zeros) pass,
 * tested first; otherwise a remote object that is not an ancestor of the
 * local one, or not here to ask about, is refused.
 */
export function checkPush(
  updates: readonly PushUpdate[],
  ancestry: (remoteOid: string, localOid: string) => Ancestry,
  policies: readonly Policy[]
): PolicyFailure[] {
  const failures: PolicyFailure[] = []
  for (const update of updates) {
    if (ZEROS.test(update.remoteOid) || ZEROS.test(update.localOid)) continue
    let answer: Ancestry | null = null
    for (const policy of policies)
      for (const rule of policy.rules) {
        if (rule.check !== 'push' || rule.deny !== NON_FAST_FORWARD) continue
        answer ??= ancestry(update.remoteOid, update.localOid)
        if (answer === 'ancestor') continue
        failures.push(
          answer === 'missing'
            ? {
                policy,
                rule,
                where: update.ref,
                line: `remote object ${short(update.remoteOid)} is not here, so the push cannot be shown to be a fast-forward`,
                fix: `Fetch first, then push again. ${rule.fix}`,
              }
            : {
                policy,
                rule,
                where: update.ref,
                line: `${NON_FAST_FORWARD}: remote ${short(update.remoteOid)} is not an ancestor of ${short(update.localOid)}`,
              }
        )
      }
  }
  return failures
}

export type PolicyAction = 'commit' | 'push' | 'edit'

/**
 * Spec 0040 §5: every failing rule of every policy in one message, grouped
 * by policy, so one correction passes. Empty for no failure.
 */
export function refusalText(
  failures: readonly PolicyFailure[],
  action: PolicyAction
): string {
  const byPolicy = new Map<string, PolicyFailure[]>()
  for (const f of failures) {
    const group = byPolicy.get(f.policy.rel) ?? []
    group.push(f)
    byPolicy.set(f.policy.rel, group)
  }
  const out: string[] = []
  for (const group of byPolicy.values()) {
    const policy = group[0]?.policy
    if (policy === undefined) continue
    out.push(`rness: policy ${policy.name} refused this ${action}`)
    // One block per rule: where it broke, then what to do.
    const byRule = new Map<string, PolicyFailure[]>()
    for (const f of group) {
      const key = `${f.rule.check}\n${f.rule.deny}\n${f.fix ?? f.rule.fix}`
      byRule.set(key, [...(byRule.get(key) ?? []), f])
    }
    for (const same of byRule.values()) {
      for (const f of same)
        out.push(`  ${f.where}: ${f.line.slice(0, LINE_CUT)}`)
      const first = same[0]
      if (first !== undefined) out.push(`  fix: ${first.fix ?? first.rule.fix}`)
    }
    if (policy.standard !== null)
      out.push(`  standard: .rness/${policy.standard}`)
    out.push(`  policy: .rness/${policy.rel}`)
  }
  return out.join('\n')
}
