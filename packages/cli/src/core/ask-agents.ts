import { TARGETS } from './agents.ts'
import type { Prompts } from './terminal.ts'

export const AGENTS_QUESTION = 'Which agents does your team use?'

/**
 * The one question that fills `agents` in rness.json (spec 0011 §3.2): the
 * targets this version compiles, none required. [] is an answer — "none, do
 * not ask again"; null is a cancel.
 */
export async function askAgents(p: Prompts): Promise<string[] | null> {
  const answer = await p.multiselect<string>({
    message: AGENTS_QUESTION,
    options: Object.values(TARGETS).map((t) => ({
      value: t.name,
      label: t.label,
    })),
    required: false,
  })
  if (p.isCancel(answer)) return null
  return Array.isArray(answer) ? answer : []
}
