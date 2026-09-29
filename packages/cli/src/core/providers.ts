import { VERSION } from '../version.ts'
import { githubProvider } from './github-oauth-provider.ts'
import type { RateWait } from './github.ts'
import type { Provider } from './provider.ts'
import type { Manifest, ProviderName } from './types.ts'

export interface OpenOptions {
  apiBase?: string
  wait?: RateWait
}

export interface ProviderEntry {
  name: ProviderName
  label: string
  available: boolean
  /** Only when `available`. */
  open?: (options: OpenOptions) => Promise<Provider>
}

/** The hosting providers rness knows by name, in the order it offers them. */
export const PROVIDERS: Readonly<Record<ProviderName, ProviderEntry>> = {
  github: {
    name: 'github',
    label: 'GitHub',
    available: true,
    open: ({ apiBase, wait }) => githubProvider(apiBase, wait),
  },
  gitlab: { name: 'gitlab', label: 'GitLab', available: false },
  atlassian: {
    name: 'atlassian',
    label: 'Atlassian — Bitbucket + Jira',
    available: false,
  },
}

export function isProviderName(value: string): value is ProviderName {
  return Object.hasOwn(PROVIDERS, value)
}

export function unsupportedProviderMessage(name: ProviderName): string {
  const supported = Object.values(PROVIDERS)
    .filter((p) => p.available)
    .map((p) => p.name)
  return `rness.json: provider "${name}" is not supported by @rness/cli ${VERSION} (supported: ${supported.join(', ')})`
}

/**
 * The workspace's provider, opened — or throws the message above. Only a
 * provider written in `rness.json` is refused: a host detected from a
 * repository URL is git's business (spec 0017 §1), and opens GitHub, whose
 * credentials answer null for other hosts.
 */
export async function openProvider(
  manifest: Manifest | null,
  options: OpenOptions = {}
): Promise<Provider> {
  const name = manifest?.provider ?? 'github'
  const entry = PROVIDERS[name]
  if (entry.open === undefined)
    throw new Error(unsupportedProviderMessage(name))
  return entry.open(options)
}

/**
 * For the commands that only clone and pull (`add`, `sync`): the provider as
 * `openProvider` opens it, or null when the written one is unavailable — git
 * then uses its own credentials instead of refusing.
 */
export async function openGitProvider(
  manifest: Manifest
): Promise<Provider | null> {
  if (manifest.provider !== null && !PROVIDERS[manifest.provider].available)
    return null
  return openProvider(manifest)
}
