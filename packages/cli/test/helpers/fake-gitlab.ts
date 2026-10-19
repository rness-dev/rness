import type { TestContext } from 'node:test'

import { type Recorded, type Route, fakeHost } from './fake-github.ts'

/**
 * gitlab.com, its OAuth endpoints and its REST API under `/api/v4`, on
 * 127.0.0.1. `route` answers every request; each one is recorded.
 * `RNESS_GITLAB_WEB` points at it for the test.
 */
export async function fakeGitlab(
  t: TestContext,
  route: Route
): Promise<{ base: string; requests: Recorded[] }> {
  return fakeHost(t, route, 'RNESS_GITLAB_WEB')
}
