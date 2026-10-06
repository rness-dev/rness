import type { StatusUpdate } from '../pulse/collection.ts'
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
  /**
   * The provider lets rness read this organization; false would wear the
   * padlock of spec 0028 §4. On GitHub it is always true: an organization
   * that restricts OAuth apps and has not approved rness is not listed at
   * all, whatever the API asked (plan 0037, task 1).
   */
  approved: boolean
  /** The identity can approve rness there itself (an owner); false: it can only ask; null: the provider would not say. */
  canGrant: boolean | null
}

/**
 * `restricted`: the organization limits OAuth apps and has not approved this
 * one, so its private repositories are hidden. `unknown`: anonymous, or the
 * question could not be answered.
 */
export type OrganizationAccess =
  'member' | 'not-member' | 'restricted' | 'unknown'

/** The pulse's board on the provider (spec 0017 §2.3). */
/** The fields a mark writes: the select from `$agent`, the text from `$session` (none: not written). */
export interface MarkFields {
  agent: string
  session: string | null
}

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
  /** Where a person approves rness for an organization (spec 0028 §3); null when the provider has no such page. */
  approvalUrl(): string | null
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
   * The board (spec 0017 §3; Issues on `.rness` first, spec 0018 §2): a
   * new, empty one for `org`, so that the caller can declare it before
   * `ensureLayout` builds it. Anonymous: refused.
   */
  createBoard(org: string, title?: string): Promise<Board>
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
  /**
   * The items of the board, not the archived ones. `bodies: false` lists
   * them without their issues' bodies (`body: null`): enough to mark them.
   */
  items(board: Board, options?: { bodies?: boolean }): Promise<BoardItem[]>
  /** The item and issue number a create or a convert gave; null for any other step. */
  apply(board: Board, step: Step): Promise<Placed | null>
  /**
   * Marks items as being worked on by `session`; null clears the mark.
   * `fields`: the board's select from `$agent` and text from `$session`
   * (spec 0031 §2.4); by default `Agent` and `Working session`.
   */
  mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null,
    fields?: MarkFields
  ): Promise<void>
  /**
   * A collection's project: its README and short description, each written
   * when given and different (spec 0025 §4). Returns what it wrote.
   */
  describe(
    board: Board,
    text: { readme: string | null; description: string | null }
  ): Promise<string[]>
  /**
   * A collection's project: each update posted once, and updated when its
   * file changed, found by its path (spec 0025 §4). Returns what it wrote.
   */
  postUpdates(board: Board, updates: readonly StatusUpdate[]): Promise<string[]>
}

/** @deprecated the pre-0.12 name, kept for the package's API. */
export type GitProvider = Provider
