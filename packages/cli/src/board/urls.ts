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

/** The providers a body is written for: GitHub's addresses above, GitLab's below. */
export type BodyProvider = 'github' | 'gitlab'

/**
 * GitLab's addresses (spec 0037 §6, §7.4): the context project `rness`,
 * gitlab.com always, as GitHub's are github.com: a card's links are read
 * in a browser, never by rness.
 */
const GITLAB = 'https://gitlab.com'

export const gitlabBoardUrl = (org: string, id: number): string =>
  `${GITLAB}/${org}/rness/-/boards/${id}`

export const gitlabBlobUrl = (org: string, path: string): string =>
  `${GITLAB}/${org}/rness/-/blob/main/${encodeURI(path)}`

export const gitlabIssueUrl = (org: string, iid: number): string =>
  `${GITLAB}/${org}/rness/-/issues/${iid}`

/** A document, an image and an issue of the context repository, on the provider. */
export interface ContextUrls {
  blob(org: string, path: string): string
  image(org: string, path: string): string
  issue(org: string, number: number): string
}

export function contextUrls(provider: BodyProvider): ContextUrls {
  return provider === 'gitlab'
    ? {
        blob: gitlabBlobUrl,
        image: (org, path) =>
          `${GITLAB}/${org}/rness/-/raw/main/${encodeURI(path)}`,
        issue: gitlabIssueUrl,
      }
    : {
        blob: blobUrl,
        image: (org, path) => `${blobUrl(org, path)}?raw=true`,
        issue: issueUrl,
      }
}
