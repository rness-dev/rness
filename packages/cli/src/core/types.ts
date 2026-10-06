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

export interface RepoEntry {
  url: string
}

export interface ScopeEntry {
  path: string
  extends: string[]
}

/** The hosting providers a workspace can name (spec 0017 §2.1). */
export type ProviderName = 'github' | 'gitlab' | 'atlassian'

/**
 * The GitHub Projects the pulse writes, by name (spec 0025 §2), in the order
 * `rness.json` gives them: each a board declared whole (spec 0031 §2.2), or
 * the project number alone of a board made before 0.21.0 — `pulse` is then
 * Agent Pulse, any other name a directory of `.rness/` — read as its preset
 * until `sync` writes it whole.
 */
export type Projects = Record<string, number | BoardDeclaration>

/** A board `rness.json` declares and rness refuses: set aside, the rest read (spec 0031 §4). */
export interface RefusedBoard {
  name: string
  /** The refusal, its full key first: `"projects.marketing.views" must …`. */
  reason: string
  /** The entry as written, kept when the file is written back. */
  source: unknown
}

export interface Manifest {
  contract: 1
  /** Null when not written: `providerOf()` infers it. */
  provider: ProviderName | null
  org: string | null
  /** The team's agents (spec 0011 §3.1); null when never asked, [] for none. */
  agents: string[] | null
  /** Null when none is declared. */
  projects: Projects | null
  /** The boards refused, absent when there are none. */
  refused?: RefusedBoard[]
  repos: Record<string, RepoEntry>
  scopes: Record<string, ScopeEntry>
}

export interface Workspace {
  root: string
  rnessDir: string
}

export type CollectionName = 'standards' | 'adr' | 'specs' | 'plans' | 'skills'

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
