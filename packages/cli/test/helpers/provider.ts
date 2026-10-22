import type {
  CreateRepositoryResult,
  OrgRepository,
} from '../../src/core/github.ts'
import type {
  Organization,
  OrganizationAccess,
  Provider,
  Tracker,
} from '../../src/core/provider.ts'

/** A scripted `Provider`; `asked` records every URL credentials were asked for. */
export function fakeProvider(spec: {
  /** Null (the default) is GitHub seen anonymously. */
  login?: string | null
  /** A name is an approved organization the login cannot administer. */
  organizations?: (string | Organization)[]
  /** One answer, or one per call (the last one repeats): a wait polls it. */
  access?: OrganizationAccess | OrganizationAccess[]
  approvalUrl?: string | null
  repositories?: OrgRepository[]
  owner?: 'org' | 'user' | 'self'
  /** Lines the listing asks to print (GitLab's duplicate paths). */
  notes?: string[]
  /** The identity's role in any organization, when the provider says it (GitLab). */
  role?: string
  /** What `createRepository` does and answers; default: refused. */
  create?: (owner: string, name: string) => Promise<CreateRepositoryResult>
  /** Atlassian's tracker, scripted: no network. */
  tracker?: Tracker
}): {
  provider: Provider
  asked: string[]
  listed: string[]
  created: string[]
  /** One entry per `organizationAccess` call: how many times a wait polled. */
  accessCalls: number[]
} {
  const login = spec.login ?? null
  // The board is not what these tests are about.
  const refused = (): Promise<never> =>
    Promise.reject(new Error('the board is not scripted'))
  const asked: string[] = []
  const listed: string[] = []
  const created: string[] = []
  const accessCalls: number[] = []
  return {
    asked,
    listed,
    created,
    accessCalls,
    provider: {
      ...(spec.tracker === undefined ? {} : { tracker: spec.tracker }),
      authenticated: login !== null,
      identity: async () => (login === null ? null : { login }),
      listOrganizations: async () =>
        (spec.organizations ?? []).map((o) =>
          typeof o === 'string'
            ? { login: o, approved: true, canGrant: false }
            : o
        ),
      organizationAccess: async () => {
        accessCalls.push(1)
        const a = spec.access ?? 'unknown'
        if (!Array.isArray(a)) return a
        return a[Math.min(accessCalls.length, a.length) - 1] ?? 'unknown'
      },
      ...(spec.role === undefined
        ? {}
        : { organizationRole: async () => spec.role ?? null }),
      approvalUrl: () =>
        spec.approvalUrl === undefined
          ? 'https://github.test/settings/connections/applications/rness'
          : spec.approvalUrl,
      scopes: async () => null,
      listRepositories: async (owner) => {
        listed.push(owner)
        return {
          repositories: spec.repositories ?? [],
          owner: spec.owner ?? 'org',
          truncated: false,
          ...(spec.notes === undefined ? {} : { notes: spec.notes }),
        }
      },
      createRepository: async (owner, name) => {
        created.push(`${owner}/${name}`)
        return (
          spec.create?.(owner, name) ?? {
            kind: 'refused',
            reason: 'not scripted',
          }
        )
      },
      checkIssues: refused,
      createBoard: refused,
      board: refused,
      ensureLayout: refused,
      items: refused,
      apply: refused,
      mark: refused,
      describe: refused,
      postUpdates: refused,
      journalIssue: refused,
      createJournalIssue: refused,
      issueOf: refused,
      addSubIssue: refused,
      comment: refused,
      pullRequestFor: refused,
      credentialsFor: (url) => {
        asked.push(url)
        return login === null
          ? null
          : { username: 'x-access-token', password: 'ghu_fake' }
      },
    },
  }
}

/** A scripted Jira for the wizard: its sites, its spaces, the keys taken, what a creation answers. */
export function fakeTracker(spec: {
  sites?: string[]
  spaces?: { key: string; name: string }[]
  taken?: string[]
  create?: CreateRepositoryResult
}): { tracker: Tracker; created: string[] } {
  const created: string[] = []
  return {
    created,
    tracker: {
      label: 'Jira',
      keyPattern: /^[A-Z][A-Z0-9]{1,9}$/,
      keyRule: 'A to Z and digits, 2 to 10, a letter first',
      kind: 'team-managed, Kanban',
      manualSteps: (site, key) => [
        `# create a team-managed Kanban space with the key ${key} on ${site}`,
        '# (Jira > Spaces > Create space > Kanban > Team-managed), then: rness board push',
      ],
      declareLine:
        '# for the cards: add "jira": { "site": "<name>.atlassian.net", "space": "<KEY>" } to rness.json',
      sites: async () => spec.sites ?? ['acme.atlassian.net'],
      spaces: async () => spec.spaces ?? [],
      keyFree: async (_site, key) => !(spec.taken ?? []).includes(key),
      createSpace: async (site, key) => {
        created.push(`${site}/${key}`)
        return spec.create ?? { kind: 'created' }
      },
    },
  }
}
