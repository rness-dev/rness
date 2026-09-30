import type { Layout } from '../pulse/layout.ts'
import type { BoardItem, Placed, Step } from '../pulse/plan.ts'
import type { CreateRepositoryResult, RepositoryListing } from './github.ts'

// The seam between the commands and the place the repositories live (spec
// 0004 §6). The commands do not know how rness is authenticated: the CLI acts
// as a user (OAuth), rness Cloud will act as an installation (GitHub App).

/** What git needs to reach a URL over HTTPS. */
export interface GitCredentials {
  username: string
  password: string
}

export interface Organization {
  login: string
}

/**
 * `restricted`: the organization limits OAuth apps and has not approved this
 * one, so its private repositories are hidden. `unknown`: anonymous, or the
 * question could not be answered.
 */
export type OrganizationAccess =
  'member' | 'not-member' | 'restricted' | 'unknown'

/** The pulse's board on the provider (spec 0017 §2.3). */
export interface Board {
  org: string
  number: number
  url: string
}

export interface Provider {
  /** False when rness sees GitHub anonymously: public repositories only. */
  readonly authenticated: boolean
  /** Who rness acts as; null when anonymous. */
  identity(): Promise<{ login: string } | null>
  /** The organizations of the identity; empty when anonymous. */
  listOrganizations(): Promise<Organization[]>
  organizationAccess(org: string): Promise<OrganizationAccess>
  listRepositories(owner: string): Promise<RepositoryListing>
  /**
   * Create the private repository `owner/name` — how a new workspace's
   * `.rness` gets to GitHub (spec 0004 §3b). Anonymous: refused.
   */
  createRepository(owner: string, name: string): Promise<CreateRepositoryResult>
  /**
   * The scopes the token holds; null when anonymous or when the provider
   * names none. Rejects when the provider cannot be asked (offline, a
   * rejected token): that is not a missing scope.
   */
  scopes(): Promise<string[] | null>
  /**
   * Credentials for `url`, or null: an SSH URL, another host, no login.
   * Cloning itself is not the provider's: `rness.json` says which URL, and
   * SSH comes first (spec 0005).
   */
  credentialsFor(url: string): GitCredentials | null
  /**
   * The board (spec 0017 §3): a new, empty one for `org`, so that the caller
   * can declare it before `ensureLayout` builds it. Anonymous: refused.
   */
  createBoard(org: string): Promise<Board>
  /** The board `number` of `org`, or null when the provider has none. */
  board(org: string, number: number): Promise<Board | null>
  /**
   * Refuses, before any write, a workspace whose organization's `.rness`
   * cannot hold the pulse's issues (spec 0018 §2). The caller asks before
   * `createBoard`, and before `ensureLayout`, which writes.
   */
  checkIssues(org: string): Promise<void>
  /**
   * Adds the fields, options and views `layout` needs; makes the label of
   * the pulse's issues and links the board to `.rness`. Returns what it
   * added (`field X`, `option X`, `view X`, `label X`, `link X`); removes
   * nothing, except the provider's default statuses on a board
   * `createBoard` just made.
   */
  ensureLayout(board: Board, layout: Layout): Promise<string[]>
  /** The items of the board, not the archived ones. */
  items(board: Board): Promise<BoardItem[]>
  /** The item and issue number a create or a convert gave; null for any other step. */
  apply(board: Board, step: Step): Promise<Placed | null>
  /** Marks items as being worked on by `session`; null clears the mark. */
  mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null
  ): Promise<void>
}

/** @deprecated the pre-0.12 name, kept for the package's API. */
export type GitProvider = Provider
