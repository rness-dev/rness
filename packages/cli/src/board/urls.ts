/**
 * Where the boards live on GitHub (spec 0017 §2, 0018 §3): the board, one
 * item of it, a document and an issue of `.rness`. Strings only: nothing
 * here reaches GitHub.
 */

export const boardUrl = (org: string, project: number): string =>
  `https://github.com/orgs/${org}/projects/${project}`

/**
 * The board filtered on one document, by its `Path` field: the one item.
 * `filterQuery` is the board's own query parameter (verified 2026-10-05).
 */
export const itemUrl = (org: string, project: number, path: string): string =>
  `${boardUrl(org, project)}?filterQuery=${encodeURIComponent(`path:"${path}"`)}`

export const blobUrl = (org: string, path: string): string =>
  `https://github.com/${org}/.rness/blob/main/${encodeURI(path)}`

export const issueUrl = (org: string, number: number): string =>
  `https://github.com/${org}/.rness/issues/${number}`
