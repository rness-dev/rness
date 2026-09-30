import type {
  CreateRepositoryResult,
  OrgRepository,
} from '../../src/core/github.ts'
import type { OrganizationAccess, Provider } from '../../src/core/provider.ts'

/** A scripted `Provider`; `asked` records every URL credentials were asked for. */
export function fakeProvider(spec: {
  /** Null (the default) is GitHub seen anonymously. */
  login?: string | null
  organizations?: string[]
  access?: OrganizationAccess
  repositories?: OrgRepository[]
  owner?: 'org' | 'user' | 'self'
  /** What `createRepository` does and answers; default: refused. */
  create?: (owner: string, name: string) => Promise<CreateRepositoryResult>
}): {
  provider: Provider
  asked: string[]
  listed: string[]
  created: string[]
} {
  const login = spec.login ?? null
  // The board is not what these tests are about.
  const refused = (): Promise<never> =>
    Promise.reject(new Error('the board is not scripted'))
  const asked: string[] = []
  const listed: string[] = []
  const created: string[] = []
  return {
    asked,
    listed,
    created,
    provider: {
      authenticated: login !== null,
      identity: async () => (login === null ? null : { login }),
      listOrganizations: async () =>
        (spec.organizations ?? []).map((name) => ({ login: name })),
      organizationAccess: async () => spec.access ?? 'unknown',
      scopes: async () => null,
      listRepositories: async (owner) => {
        listed.push(owner)
        return {
          repositories: spec.repositories ?? [],
          owner: spec.owner ?? 'org',
          truncated: false,
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
      credentialsFor: (url) => {
        asked.push(url)
        return login === null
          ? null
          : { username: 'x-access-token', password: 'ghu_fake' }
      },
    },
  }
}
