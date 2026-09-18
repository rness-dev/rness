import type { RepositoryListing } from './github.ts'

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

export interface GitProvider {
  /** False when rness sees GitHub anonymously: public repositories only. */
  readonly authenticated: boolean
  /** Who rness acts as; null when anonymous. */
  identity(): Promise<{ login: string } | null>
  /** The organizations of the identity; empty when anonymous. */
  listOrganizations(): Promise<Organization[]>
  organizationAccess(org: string): Promise<OrganizationAccess>
  listRepositories(owner: string): Promise<RepositoryListing>
  /**
   * Credentials for `url`, or null: an SSH URL, another host, no login.
   * Cloning itself is not the provider's: `rness.json` says which URL, and
   * SSH comes first (spec 0005).
   */
  credentialsFor(url: string): GitCredentials | null
}
