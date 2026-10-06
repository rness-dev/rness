import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/**
 * A path of `.rness/` as `rness.json` may name one (`marketing/README.md`):
 * relative, plain segments, none hidden and none `..`. `rness.json` is the
 * organization's: a path out of `.rness` would publish a developer's file
 * (a key, a token) on GitHub at their next sync.
 */
export const RNESS_PATH =
  /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

/**
 * `rel` under `root`, refused when its real path — links followed — leads
 * out of `root`'s. Throws ENOENT as `realpath` does when it is not there.
 */
export async function containedPath(
  root: string,
  rel: string
): Promise<string> {
  if (!RNESS_PATH.test(rel))
    throw new Error(`${rel} is not a path within .rness`)
  const path = join(root, ...rel.split('/'))
  const [realRoot, real] = await Promise.all([realpath(root), realpath(path)])
  const inside = relative(realRoot, real)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    throw new Error(`${rel} leads out of .rness: rness reads nothing there`)
  return path
}
