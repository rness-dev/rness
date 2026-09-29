import { VERSION } from '../version.ts'
import { githubProvider } from './github-oauth-provider.ts'
import { providerOf } from './manifest.ts'
import type { Provider } from './provider.ts'
import type { Manifest, ProviderName } from './types.ts'

export interface ProviderEntry {
  name: ProviderName
  label: string
  available: boolean
  /** Only when `available`. */
  open?: (options: { apiBase?: string }) => Promise<Provider>
}

/** The hosting providers rness knows by name, in the order it offers them. */
export const PROVIDERS: Readonly<Record<ProviderName, ProviderEntry>> = {
  github: {
    name: 'github',
    label: 'GitHub',
    available: true,
    open: ({ apiBase }) => githubProvider(apiBase),
  },
  gitlab: { name: 'gitlab', label: 'GitLab', available: false },
  atlassian: {
    name: 'atlassian',
    label: 'Atlassian — Bitbucket + Jira',
    available: false,
  },
}

export function unsupportedProviderMessage(name: ProviderName): string {
  const supported = Object.values(PROVIDERS)
    .filter((p) => p.available)
    .map((p) => p.name)
  return `rness.json: provider "${name}" is not supported by @rness/cli ${VERSION} (supported: ${supported.join(', ')})`
}

/** The workspace's provider, opened — or throws the message above. */
export async function openProvider(
  manifest: Manifest | null,
  options: { apiBase?: string } = {}
): Promise<Provider> {
  const name = manifest === null ? 'github' : providerOf(manifest)
  const entry = PROVIDERS[name]
  if (entry.open === undefined)
    throw new Error(unsupportedProviderMessage(name))
  return entry.open(options)
}
