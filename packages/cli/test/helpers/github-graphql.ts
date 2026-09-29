/** A fake GitHub GraphQL server: answers by a needle found in the query. */
import { type Recorded, type Reply, fakeGithub } from './fake-github.ts'

export interface Gql {
  query: string
  variables: Record<string, unknown>
}

export const gql = (r: Recorded): Gql => r.body as Gql
export const data = (d: unknown): Reply => ({ json: { data: d } })

/** The field as GitHub answers it: `databaseId` only when the query selects it. */
export const asked = (query: string, field: Record<string, unknown>) => {
  const { databaseId, ...rest } = field
  return /\bdatabaseId\b/.test(query) ? { ...rest, databaseId } : rest
}

export async function serve(
  t: Parameters<typeof fakeGithub>[0],
  answers: Record<string, (v: Record<string, unknown>, query: string) => Reply>
) {
  const github = await fakeGithub(t, (r) => {
    const { query, variables } = gql(r)
    for (const [needle, answer] of Object.entries(answers))
      if (query.includes(needle)) return answer(variables, query)
    return { status: 500, json: { message: `unexpected ${query}` } }
  })
  return { ...github, o: { token: 'tok', apiBase: github.base } }
}
