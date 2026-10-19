import type { TestContext } from 'node:test'

import { type Recorded, type Route, fakeHost } from './fake-github.ts'

/**
 * api.bitbucket.org, its REST API under `/2.0`, on 127.0.0.1. `route`
 * answers every request; each one is recorded. `RNESS_BITBUCKET_API` points
 * at it for the test.
 */
export async function fakeBitbucket(
  t: TestContext,
  route: Route
): Promise<{ base: string; requests: Recorded[] }> {
  return fakeHost(t, route, 'RNESS_BITBUCKET_API')
}
