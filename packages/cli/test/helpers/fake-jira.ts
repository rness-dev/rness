import type { TestContext } from 'node:test'

import { type Recorded, type Route, fakeHost } from './fake-github.ts'

/**
 * Every Jira site (`https://<site>.atlassian.net`) on 127.0.0.1: its REST
 * API under `/rest`. `route` answers every request; each one is recorded.
 * `RNESS_JIRA_WEB` points every site at it for the test.
 */
export async function fakeJira(
  t: TestContext,
  route: Route
): Promise<{ base: string; requests: Recorded[] }> {
  return fakeHost(t, route, 'RNESS_JIRA_WEB')
}
