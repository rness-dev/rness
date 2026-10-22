import type { AdfDocument } from '../board/adf.ts'
import { MAX_PAGES } from './github.ts'
import { type JiraApiOptions, jiraFailure, jiraRequest } from './jira.ts'

// The issues of a Jira space (spec 0039 §6), on the site's REST API v3:
// what the journal (plan 0053 task 5) and the board (task 6) do with them.
// Names are translated on a site in another language (task 1): types,
// statuses and transitions are picked by id, never by name.

const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const segment = (s: string): string => encodeURIComponent(s)

/** `RNESS-12` → 12; NaN for anything else. */
export const issueNumber = (key: string): number =>
  Number(/-(\d+)$/.exec(key)?.[1] ?? Number.NaN)

/** The space `key` on the site: its id and key; null when it is not there, or not visible. */
export async function space(
  key: string,
  o: JiraApiOptions
): Promise<{ id: string; key: string } | null> {
  const path = `/rest/api/3/project/${segment(key)}`
  const answer = await jiraRequest('GET', path, o)
  if (answer.status === 404) return null
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const id = field(answer.body, 'id')
  return {
    id: typeof id === 'number' ? String(id) : (str(id) ?? ''),
    key: str(field(answer.body, 'key')) ?? key,
  }
}

/** The permissions of `wanted` the user lacks in the space, by Jira's name. */
export async function missingPermissions(
  key: string,
  wanted: readonly string[],
  o: JiraApiOptions
): Promise<string[]> {
  const q = new URLSearchParams({
    projectKey: key,
    permissions: wanted.join(','),
  })
  const path = '/rest/api/3/mypermissions'
  const answer = await jiraRequest('GET', `${path}?${q}`, o)
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const granted = field(answer.body, 'permissions')
  return wanted.filter(
    (p) => field(field(granted, p), 'havePermission') !== true
  )
}

/**
 * The id of the space's Task type (team-managed types are per space): the
 * one whose untranslated name is `Task`, else the first of level 0 by id
 * (the template makes Task first, task 1); a translated name never decides.
 */
export async function taskType(
  key: string,
  o: JiraApiOptions
): Promise<string> {
  const path = `/rest/api/3/issue/createmeta/${segment(key)}/issuetypes`
  const answer = await jiraRequest('GET', path, o)
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const listed =
    field(answer.body, 'issueTypes') ?? field(answer.body, 'values')
  const types = (Array.isArray(listed) ? listed : [])
    .map((t) => ({
      id: str(field(t, 'id')) ?? '',
      level: field(t, 'hierarchyLevel'),
      untranslated: str(field(t, 'untranslatedName')),
    }))
    .filter((t) => t.id !== '' && t.level === 0)
    .sort((a, b) => Number(a.id) - Number(b.id))
  const task = types.find((t) => t.untranslated === 'Task') ?? types[0]
  if (task === undefined)
    throw new Error(`${key} has no issue type of level 0 on ${o.site}`)
  return task.id
}

/** A new issue of the space: its key and its number. */
export async function createIssue(
  key: string,
  typeId: string,
  fields: { summary: string; description: AdfDocument; labels: string[] },
  o: JiraApiOptions
): Promise<{ key: string; number: number }> {
  const path = '/rest/api/3/issue'
  const answer = await jiraRequest('POST', path, o, {
    fields: {
      project: { key },
      issuetype: { id: typeId },
      summary: fields.summary,
      description: fields.description,
      labels: fields.labels,
    },
  })
  const made = str(field(answer.body, 'key'))
  if (answer.status !== 201 || made === null) throw jiraFailure(o, answer, path)
  return { key: made, number: issueNumber(made) }
}

/** `summary` and `description` set, labels added and removed, in one call. */
export async function updateIssue(
  key: string,
  change: {
    summary?: string
    description?: AdfDocument
    add?: readonly string[]
    remove?: readonly string[]
  },
  o: JiraApiOptions
): Promise<void> {
  const fields = {
    ...(change.summary === undefined ? {} : { summary: change.summary }),
    ...(change.description === undefined
      ? {}
      : { description: change.description }),
  }
  const labels = [
    ...(change.add ?? []).map((l) => ({ add: l })),
    ...(change.remove ?? []).map((l) => ({ remove: l })),
  ]
  const path = `/rest/api/3/issue/${segment(key)}`
  const answer = await jiraRequest('PUT', path, o, {
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(labels.length === 0 ? {} : { update: { labels } }),
  })
  if (answer.status !== 204 && answer.status !== 200)
    throw jiraFailure(o, answer, path)
}

/** An issue as rness reads it back. */
export interface JiraIssue {
  key: string
  number: number
  summary: string
  labels: string[]
  statusId: string | null
  /** Its status is of the category Done. */
  done: boolean
  description: AdfDocument | null
}

function toIssue(value: unknown): JiraIssue | null {
  const key = str(field(value, 'key'))
  if (key === null) return null
  const fields = field(value, 'fields')
  const status = field(fields, 'status')
  const labels = field(fields, 'labels')
  const description = field(fields, 'description')
  return {
    key,
    number: issueNumber(key),
    summary: str(field(fields, 'summary')) ?? '',
    labels: Array.isArray(labels)
      ? labels.filter((l): l is string => typeof l === 'string')
      : [],
    statusId: str(field(status, 'id')),
    done: field(field(status, 'statusCategory'), 'key') === 'done',
    description:
      description !== null && typeof description === 'object'
        ? (description as AdfDocument)
        : null,
  }
}

/** The fields rness reads off an issue. */
export const ISSUE_FIELDS = ['summary', 'labels', 'status', 'description']

/** The issue `key`, or null when there is none. */
export async function issue(
  key: string,
  o: JiraApiOptions
): Promise<JiraIssue | null> {
  const path = `/rest/api/3/issue/${segment(key)}`
  const q = new URLSearchParams({ fields: ISSUE_FIELDS.join(',') })
  const answer = await jiraRequest('GET', `${path}?${q}`, o)
  if (answer.status === 404) return null
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  return toIssue(answer.body)
}

/** The transitions an issue can take now, by the id of the status each leads to. */
export async function transitions(
  key: string,
  o: JiraApiOptions
): Promise<{ id: string; to: string }[]> {
  const path = `/rest/api/3/issue/${segment(key)}/transitions`
  const answer = await jiraRequest('GET', path, o)
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  const listed = field(answer.body, 'transitions')
  return (Array.isArray(listed) ? listed : []).flatMap((t) => {
    const id = str(field(t, 'id'))
    const to = str(field(field(t, 'to'), 'id'))
    return id === null || to === null ? [] : [{ id, to }]
  })
}

export async function transition(
  key: string,
  id: string,
  o: JiraApiOptions
): Promise<void> {
  const path = `/rest/api/3/issue/${segment(key)}/transitions`
  const answer = await jiraRequest('POST', path, o, { transition: { id } })
  if (answer.status !== 204 && answer.status !== 200)
    throw jiraFailure(o, answer, path)
}

/** An issue property, written whole (the digest: `{ digest }`). */
export async function setProperty(
  key: string,
  name: string,
  value: unknown,
  o: JiraApiOptions
): Promise<void> {
  const path = `/rest/api/3/issue/${segment(key)}/properties/${segment(name)}`
  const answer = await jiraRequest('PUT', path, o, value)
  if (answer.status !== 200 && answer.status !== 201)
    throw jiraFailure(o, answer, path)
}

/** An issue property's value; null when it has none. */
export async function property(
  key: string,
  name: string,
  o: JiraApiOptions
): Promise<unknown> {
  const path = `/rest/api/3/issue/${segment(key)}/properties/${segment(name)}`
  const answer = await jiraRequest('GET', path, o)
  if (answer.status === 404) return null
  if (answer.status !== 200) throw jiraFailure(o, answer, path)
  return field(answer.body, 'value') ?? null
}

/** The issues a JQL query finds, with `fields`, paged by `nextPageToken` up to `MAX_PAGES`. */
export async function search(
  jql: string,
  fields: readonly string[],
  o: JiraApiOptions
): Promise<JiraIssue[]> {
  const path = '/rest/api/3/search/jql'
  const found: JiraIssue[] = []
  let token: string | null = null
  for (let n = 1; n <= MAX_PAGES; n++) {
    const q = new URLSearchParams({
      jql,
      fields: fields.join(','),
      maxResults: '100',
      ...(token === null ? {} : { nextPageToken: token }),
    })
    const answer = await jiraRequest('GET', `${path}?${q}`, o)
    if (answer.status !== 200) throw jiraFailure(o, answer, path)
    const issues = field(answer.body, 'issues')
    for (const i of Array.isArray(issues) ? issues : []) {
      const read = toIssue(i)
      if (read !== null) found.push(read)
    }
    token = str(field(answer.body, 'nextPageToken'))
    if (token === null || field(answer.body, 'isLast') === true) break
  }
  return found
}

/** A comment on the issue, its body in ADF. */
export async function comment(
  key: string,
  body: AdfDocument,
  o: JiraApiOptions
): Promise<void> {
  const path = `/rest/api/3/issue/${segment(key)}/comment`
  const answer = await jiraRequest('POST', path, o, { body })
  if (answer.status !== 201 && answer.status !== 200)
    throw jiraFailure(o, answer, path)
}

/** Two issues linked `Relates`, shown on both (task 1: 201 on a site in French too). */
export async function relate(
  inward: string,
  outward: string,
  o: JiraApiOptions
): Promise<void> {
  const path = '/rest/api/3/issueLink'
  const answer = await jiraRequest('POST', path, o, {
    type: { name: 'Relates' },
    inwardIssue: { key: inward },
    outwardIssue: { key: outward },
  })
  if (answer.status !== 201 && answer.status !== 200)
    throw jiraFailure(o, answer, path)
}
