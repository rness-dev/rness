import type { ProviderName } from './types.ts'

/**
 * What rness needs to know of a git host it logs in to: where it is, how git
 * reaches it, how its OAuth device flow is spoken (spec 0004 for GitHub,
 * spec 0037 §3 for GitLab). One row per provider with a login; the rest of
 * the code reads the row instead of naming the host.
 */
export interface HostSpec {
  provider: 'github' | 'gitlab' | 'atlassian'
  /**
   * How `rness login` gets a token: the OAuth device flow (GitHub, GitLab),
   * or an API token typed in (Bitbucket: no device flow, spec 0039 §3).
   */
  loginKind: 'device' | 'token'
  /** How the user calls it: `GitHub`. */
  label: string
  /** The host git and `auth.json` know it by: `github.com`. */
  host: string
  /** The web origin of the OAuth endpoints, without a trailing slash. */
  web: string
  /** The variable that points `web` elsewhere in tests. */
  webEnv: string
  /** The two bases a repository URL is written with (spec 0005). */
  https: string
  ssh: string
  /** What `ssh -T git@<host>` prints for an accepted key; its first group, when there is one, the login. */
  greeting: RegExp
  /** The username git sends with the token over HTTPS. */
  username: string
  /** Variables whose token wins over the stored login, in order. */
  tokenEnv: readonly string[]
  /** OAuth paths under `web`. */
  deviceCodePath: string
  tokenPath: string
  /** What `rness login` asks for. */
  scopes: string
  /** The client ID of the shipped OAuth application. Public by nature. */
  clientId: string
  clientIdEnv: string
  /** The error the device-code request answers when the application cannot do the device flow. */
  deviceFlowDisabled: string
  /** Where to set up an SSH key. */
  sshDocs: string
}

export const HOSTS = {
  github: {
    provider: 'github',
    loginKind: 'device',
    label: 'GitHub',
    host: 'github.com',
    web: 'https://github.com',
    webEnv: 'RNESS_GITHUB_WEB',
    https: 'https://github.com/',
    ssh: 'git@github.com:',
    greeting: /^Hi ([^!\s]+)! You've successfully authenticated/m,
    username: 'x-access-token',
    tokenEnv: ['GITHUB_TOKEN', 'GH_TOKEN'],
    deviceCodePath: '/login/device/code',
    tokenPath: '/login/oauth/access_token',
    scopes: 'repo read:org',
    // The OAuth App "Rness" of the rness-dev organization.
    clientId: 'Ov23liv1ia2UWeWttsOK',
    clientIdEnv: 'RNESS_GITHUB_CLIENT_ID',
    deviceFlowDisabled: 'device_flow_disabled',
    sshDocs:
      'https://docs.github.com/authentication/connecting-to-github-with-ssh',
  },
  gitlab: {
    provider: 'gitlab',
    loginKind: 'device',
    label: 'GitLab',
    host: 'gitlab.com',
    web: 'https://gitlab.com',
    webEnv: 'RNESS_GITLAB_WEB',
    https: 'https://gitlab.com/',
    ssh: 'git@gitlab.com:',
    greeting: /^Welcome to GitLab, @([^!\s]+)!/m,
    username: 'oauth2',
    tokenEnv: ['GITLAB_TOKEN'],
    deviceCodePath: '/oauth/authorize_device',
    tokenPath: '/oauth/token',
    scopes: 'api write_repository',
    // The application "Rness" of the group rness-dev (spec 0037 §3).
    clientId:
      '8b3fb7faf4ba06b5352dbe5d3c90b3206ef5e7a9734a578429ab145e10917103',
    clientIdEnv: 'RNESS_GITLAB_CLIENT_ID',
    // gitlab.com, while the application's "Device authorization grant" box
    // is unchecked (plan 0049 task 1).
    deviceFlowDisabled: 'access_denied',
    sshDocs: 'https://docs.gitlab.com/user/ssh/',
  },
  // Atlassian's git host (spec 0039): an API token with scopes, typed in;
  // Jira is no row, its host is the workspace's site.
  bitbucket: {
    provider: 'atlassian',
    loginKind: 'token',
    label: 'Bitbucket',
    host: 'bitbucket.org',
    web: 'https://bitbucket.org',
    webEnv: 'RNESS_BITBUCKET_WEB',
    https: 'https://bitbucket.org/',
    // SSH on bitbucket.org is refused after 2026-11-12 (spec 0039 §1).
    ssh: 'git@ssh.bitbucket.org:',
    // No login in Bitbucket's greeting.
    greeting: /^authenticated via ssh key\./m,
    username: 'x-bitbucket-api-token-auth',
    tokenEnv: ['BITBUCKET_TOKEN'],
    deviceCodePath: '',
    tokenPath: '',
    scopes:
      'read:user:bitbucket read:workspace:bitbucket read:project:bitbucket read:repository:bitbucket write:repository:bitbucket admin:repository:bitbucket read:pullrequest:bitbucket',
    clientId: '',
    clientIdEnv: '',
    deviceFlowDisabled: '',
    sshDocs:
      'https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/',
  },
} as const satisfies Record<string, HostSpec>

/** Where the tokens of a token login are made, and revoked (spec 0039 §3). */
export const ATLASSIAN_TOKENS =
  'https://id.atlassian.com/manage-profile/security/api-tokens'

/** The row of a provider, or null for one rness cannot log in to. */
export function hostFor(provider: ProviderName): HostSpec | null {
  if (provider === 'atlassian') return HOSTS.bitbucket
  return provider === 'github' || provider === 'gitlab' ? HOSTS[provider] : null
}

/** The row whose `host` is `name` exactly (`git credential` asks by host). */
export function hostNamed(name: string): HostSpec | null {
  return Object.values(HOSTS).find((h) => h.host === name) ?? null
}

/** `web`, or what `webEnv` points it at; without a trailing slash. */
export function webBase(spec: HostSpec): string {
  return (process.env[spec.webEnv] ?? spec.web).replace(/\/+$/, '')
}

/** The shipped client ID, or what `clientIdEnv` overrides it with. */
export function clientIdOf(spec: HostSpec): string {
  return process.env[spec.clientIdEnv] ?? spec.clientId
}

/**
 * Where the user revokes what `rness login` was granted: GitHub's page of
 * the OAuth app, GitLab's Applications page of the user's settings (spec
 * 0037 §3).
 */
export function revokeUrl(spec: HostSpec): string {
  if (spec.loginKind === 'token') return ATLASSIAN_TOKENS
  return spec.provider === 'github'
    ? `${spec.web}/settings/connections/applications/${clientIdOf(spec)}`
    : `${spec.web}/-/user_settings/applications`
}

/** ` --provider gitlab`, for a command a line suggests; nothing for GitHub, the default outside a workspace. */
export function providerFlag(spec: HostSpec): string {
  return spec.provider === 'github' ? '' : ` --provider ${spec.provider}`
}

/** `https://github.com`: the HTTPS base without its slash, as git's config keys read it. */
export function httpsOrigin(spec: HostSpec): string {
  return spec.https.replace(/\/+$/, '')
}
