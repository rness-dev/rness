import { PROVIDERS } from './providers.ts'
import type { Prompts } from './terminal.ts'
import type { ProviderName } from './types.ts'

export const PROVIDER_QUESTION = 'Where does your organization live?'

/**
 * The question that fills `provider` in a new rness.json (spec 0017 §2.2).
 * The providers not yet implemented are listed, disabled, so the choice is
 * visibly a later one; a cancel is the clack symbol.
 */
export async function askProvider(p: Prompts): Promise<ProviderName | symbol> {
  return p.select<ProviderName>({
    message: PROVIDER_QUESTION,
    options: Object.values(PROVIDERS).map((entry) => ({
      value: entry.name,
      label: entry.available ? entry.label : `${entry.label} (coming later)`,
      disabled: !entry.available,
    })),
  })
}
