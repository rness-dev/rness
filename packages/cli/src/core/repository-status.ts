/**
 * Whether a repository exists, as a provider's API answers it: by its status
 * code, never by the wording of a message, which a host may change at will.
 * `create` asks it of the organization's context repository once access to
 * the organization has been checked (spec 0028 §3), so a 404 there means
 * absent, not hidden from a stranger.
 */
export type RepositoryStatus =
  | { kind: 'found' }
  | { kind: 'not-found' }
  | { kind: 'error'; status: number; message: string }

/**
 * The status code of `GET` on a repository, read: 200 found, 404 not found;
 * 401 (a refused token), 403 (no access) and anything else are errors that
 * name the host, the repository and the code.
 */
export function repositoryStatusOf(
  status: number,
  host: string,
  repository: string
): RepositoryStatus {
  if (status === 200) return { kind: 'found' }
  if (status === 404) return { kind: 'not-found' }
  const why =
    status === 401
      ? `${host} refused the token (401)`
      : status === 403
        ? `no access to ${repository} on ${host} (403)`
        : `${host} answered ${status} for ${repository}`
  return { kind: 'error', status, message: why }
}
