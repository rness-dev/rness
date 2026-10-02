import { PROVIDERS } from './providers.ts'
import type { Prompts } from './terminal.ts'
import type { ProviderName } from './types.ts'

export const PROVIDER_QUESTION = 'Where does your organization live?'
/** The answer that is no provider at all: the blank workspace of spec 0012. */
export const BLANK = 'blank'
export const BLANK_LABEL = 'No organization yet: a blank local workspace'

/**
 * The first question of the wizard (spec 0028 §2): where the organization
 * lives, and the blank workspace as the answer "nowhere" (spec 0012 §1
 * folded in). The providers not yet implemented are listed, disabled, so
 * the choice is visibly a later one (spec 0017 §2.2); a cancel is the clack
 * symbol.
 */
export async function askProvider(
  p: Prompts
): Promise<ProviderName | typeof BLANK | symbol> {
  return p.select<ProviderName | typeof BLANK>({
    message: PROVIDER_QUESTION,
    options: [
      ...Object.values(PROVIDERS).map((entry) => ({
        value: entry.name,
        label: entry.available ? entry.label : `${entry.label} (coming later)`,
        disabled: !entry.available,
      })),
      { value: BLANK, label: BLANK_LABEL, disabled: false },
    ],
  })
}
