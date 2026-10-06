import agentPulse1 from '../presets/agent-pulse.1.json' with { type: 'json' }
import collection1 from '../presets/collection.1.json' with { type: 'json' }

/**
 * The boards rness ships (spec 0031 §3): `agent-pulse`, and `collection`,
 * a template for one directory's own board. Each preset keeps every
 * revision it had, oldest first: a board records the one it was made from,
 * and `sync` merges a newer one into it (plan 0045). Bundled, never read
 * from disk: the running copy's folder may be gone during an upgrade.
 */

export type PresetName = 'agent-pulse' | 'collection'

const REVISIONS: Readonly<Record<PresetName, readonly unknown[]>> = {
  'agent-pulse': [agentPulse1],
  collection: [collection1],
}

const REF = /^([a-z][a-z0-9-]*)\/([1-9][0-9]*)$/

/** A tab's label, as `rness status` makes it for a directory: capitalised. */
export const labelOf = (name: string): string =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** The latest revision of a preset, as a board records it: `agent-pulse/1`. */
export const currentPreset = (name: PresetName): string =>
  `${name}/${REVISIONS[name].length}`

function revisionOf(ref: string): unknown {
  const [, name, n] = REF.exec(ref) ?? []
  if (name === undefined || n === undefined || !Object.hasOwn(REVISIONS, name))
    return undefined
  return REVISIONS[name as PresetName][Number(n) - 1]
}

/** Whether this rness bundles that revision. */
export const isPresetRevision = (ref: string): boolean =>
  revisionOf(ref) !== undefined

/** The preset's name in a reference: `agent-pulse/1` → `agent-pulse`. */
export const presetNameOf = (ref: string): string => ref.split('/')[0] ?? ''

/** `{collection}` and `{label}` in keys and texts, for one directory. */
function instantiate(value: unknown, collection: string): unknown {
  const fill = (s: string): string =>
    s
      .replaceAll('{collection}', collection)
      .replaceAll('{label}', labelOf(collection))
  if (typeof value === 'string') return fill(value)
  if (Array.isArray(value)) return value.map((v) => instantiate(v, collection))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        fill(k),
        instantiate(v, collection),
      ])
    )
  return value
}

/** A revision's board, without its number, a fresh copy: `collection` names the directory a template is for. */
export function presetTemplate(
  ref: string,
  vars: { collection: string }
): Record<string, unknown> {
  const revision = revisionOf(ref)
  if (revision === undefined) throw new Error(`no preset ${ref}`)
  return instantiate(revision, vars.collection) as Record<string, unknown>
}
