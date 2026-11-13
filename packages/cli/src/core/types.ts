import type { BoardDeclaration } from './board-declaration.ts'

export type Fields = Record<string, unknown>

export interface MarkdownItem {
  /** Absolute path. */
  path: string
  /** POSIX path relative to the collected directory. */
  rel: string
  /** Parsed front matter; null when absent or invalid (see fieldsError). */
  fields: Fields | null
  /** Parse error message when the front matter block is invalid. */
  fieldsError: string | null
  title: string | null
  /** The whole file, front matter included. */
  body: string
  /** The file with its leading front-matter block removed — what gets rendered. */
  content: string
}

/**
 * A scope of `rness.json` (ADR 0012): a repository, by its `url`, or a part
 * of one, nested under its parent. The file's tree is read flat, in the order
 * written, each scope with what `resolveScope` and `scopeChain` read.
 */
export interface ScopeEntry {
  /** From the workspace root: `org/platform` for a repository, `org/platform/apps/web` for a part. */
  path: string
  /** A repository's clone URL; null for a part. */
  url: string | null
  /** The scope a part is nested under; null for a repository. */
  parent: string | null
  /** The parent first, when there is one, then the names `extends` lists but its ancestors. */
  extends: string[]
  /**
   * The ancestors `extends` named, in the order written: inherited by
   * nesting already, left out of `extends`, and said by
   * `redundantExtends()` (ADR 0012). Absent when there is none.
   */
  redundant?: string[]
  /** The team skills this scope and its parts get (spec 0041 §2), by name; absent when none. */
  skills?: Record<string, SkillEntry>
}

/**
 * A team skill as `rness.json` declares it (spec 0041 §2): where it is
 * copied from, and the hash of the copy. The name is the key it is held under.
 */
export interface SkillEntry {
  /** `github:<owner>/<repo>`, `git:<url>` or `path:<directory>`. */
  source: string
  /** The skill's directory inside a repository source; absent: its root. */
  path?: string
  /** A tag, a branch or a commit, as given; absent: the default branch. */
  ref?: string
  /** The commit `ref` resolved to when the copy was made. */
  commit?: string
  /** `sha256-<base64>` of the copied directory. */
  hash: string
}

/** A scope with a `url`, as `repositories()` gives it: cloned at `dir`, `org/<name>`. */
export interface Repository {
  name: string
  url: string
  dir: string
}

/** The hosting providers a workspace can name (spec 0017 §2.1). */
export type ProviderName = 'github' | 'gitlab' | 'atlassian'

/**
 * A board of `boards`, by name (spec 0025 §2, 0033 §3), in the order
 * `rness.json` gives them: one declared whole (spec 0031 §2.2), its
 * `number` absent until `board push` creates it; a preset not created yet,
 * by name (`agent-pulse`, `collection/1`; spec 0033 §4); or the project
 * number alone of a board made before 0.21.0 — `pulse` is then Agent Pulse,
 * any other name a directory of `.rness/` — read as its preset until `sync`
 * writes it whole.
 */
export type BoardEntry = number | string | BoardDeclaration
export type Boards = Record<string, BoardEntry>

/** A board `rness.json` declares and rness refuses: set aside, the rest read (spec 0031 §4). */
export interface RefusedBoard {
  name: string
  /** The refusal, its full key first: `"boards.marketing.views" must …`. */
  reason: string
  /** The entry as written, kept when the file is written back. */
  source: unknown
}

/** Where an Atlassian workspace's cards live: a Jira site and a space on it (spec 0039 §2). */
export interface JiraTarget {
  /** `<name>.atlassian.net`. */
  site: string
  /** The space's key: `RNESS`. */
  space: string
}

export interface Manifest {
  /**
   * 2 from both readers: `parseManifest`, and `readContract1`, which gives
   * the former shape as contract 2 for `upgrade` to write. No reader gives 1.
   */
  contract: 1 | 2
  /** Null when not written: `providerOf()` infers it. */
  provider: ProviderName | null
  org: string | null
  /** Atlassian only; absent when not written. */
  jira?: JiraTarget
  /** The team's agents (spec 0011 §3.1); null when never asked, [] for none. */
  agents: string[] | null
  /** Null when none is declared. */
  boards: Boards | null
  /** The former key `readContract1` read the boards from: written back as `boards`. */
  formerKey?: 'projects' | 'pulse'
  /** The boards refused, absent when there are none. */
  refused?: RefusedBoard[]
  /** Every scope of the tree, by its name: names are unique across it. */
  scopes: Record<string, ScopeEntry>
  /** The team skills of the whole organization (spec 0041 §2), by name; absent when none. */
  skills?: Record<string, SkillEntry>
}

export interface Workspace {
  root: string
  rnessDir: string
}

export type CollectionName =
  'standards' | 'adr' | 'specs' | 'plans' | 'skills' | 'policy'

export interface ContextFile {
  rel: string
  scope: string | null
  title: string | null
  /** The whole file, front matter included. */
  body: string
  /** The file with its leading front-matter block removed — what gets rendered. */
  content: string
}

export interface ContextCollection {
  name: CollectionName
  files: ContextFile[]
}

export interface Context {
  scope: string | null
  collections: ContextCollection[]
}
