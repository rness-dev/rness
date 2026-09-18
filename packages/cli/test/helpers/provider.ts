import type { OrgRepository } from '../../src/core/github.ts'
import type {
  GitProvider,
  OrganizationAccess,
} from '../../src/core/provider.ts'

/** A scripted `GitProvider`; `asked` records every URL credentials were asked for. */
export function fakeProvider(spec: {
  /** Null (the default) is GitHub seen anonymously. */
  login?: string | null
  organizations?: string[]
  access?: OrganizationAccess
  repositories?: OrgRepository[]
  owner?: 'org' | 'user' | 'self'
}): { provider: GitProvider; asked: string[]; listed: string[] } {
  const login = spec.login ?? null
  const asked: string[] = []
  const listed: string[] = []
  return {
    asked,
    listed,
    provider: {
      authenticated: login !== null,
      identity: async () => (login === null ? null : { login }),
      listOrganizations: async () =>
        (spec.organizations ?? []).map((name) => ({ login: name })),
      organizationAccess: async () => spec.access ?? 'unknown',
      listRepositories: async (owner) => {
        listed.push(owner)
        return {
          repositories: spec.repositories ?? [],
          owner: spec.owner ?? 'org',
          truncated: false,
        }
      },
      credentialsFor: (url) => {
        asked.push(url)
        return login === null
          ? null
          : { username: 'x-access-token', password: 'ghu_fake' }
      },
    },
  }
}
