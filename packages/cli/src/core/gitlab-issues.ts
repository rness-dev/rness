import {
  type GitlabApiOptions,
  failure,
  field,
  gitlabCall,
  pages,
  segment,
} from './gitlab.ts'

// The issues of a GitLab project (spec 0037 §6): REST v4, a project
// addressed by its path. Labels travel as one comma-separated field; a
// status is a label, so an update adds and removes labels in one call
// (plan 0049 task 1).

export interface GitlabIssue {
  /** The number shown: `#3`. */
  iid: number
  title: string
  description: string
  labels: string[]
  state: string
}

function toIssue(value: unknown): GitlabIssue | null {
  const iid = field(value, 'iid')
  if (typeof iid !== 'number') return null
  const text = (key: string): string => {
    const v = field(value, key)
    return typeof v === 'string' ? v : ''
  }
  const labels = field(value, 'labels')
  return {
    iid,
    title: text('title'),
    description: text('description'),
    labels: Array.isArray(labels)
      ? labels.filter((l): l is string => typeof l === 'string')
      : [],
    state: text('state'),
  }
}

const issuesOf = (path: string): string => `/projects/${segment(path)}/issues`

function issueOrFail(
  answer: { status: number; headers: Headers; body: unknown },
  path: string
): GitlabIssue {
  if (answer.status < 200 || answer.status >= 300) throw failure(answer, path)
  const made = toIssue(answer.body)
  if (made === null)
    throw new Error(`GitLab API answered an unexpected body for ${path}`)
  return made
}

/** A project's numeric id and whether it takes issues; null when GitLab knows none, or not visibly. */
export async function projectOf(
  path: string,
  o: GitlabApiOptions
): Promise<{ id: number; issues: boolean } | null> {
  const at = `/projects/${segment(path)}`
  const answer = await gitlabCall('GET', at, o)
  if (answer.status === 404) return null
  const id = field(answer.body, 'id')
  if (answer.status !== 200 || typeof id !== 'number') throw failure(answer, at)
  return {
    id,
    issues: field(answer.body, 'issues_access_level') !== 'disabled',
  }
}

export async function createIssue(
  path: string,
  issue: { title: string; description: string; labels: readonly string[] },
  o: GitlabApiOptions
): Promise<GitlabIssue> {
  const at = issuesOf(path)
  return issueOrFail(
    await gitlabCall('POST', at, o, {
      title: issue.title,
      description: issue.description,
      labels: issue.labels.join(','),
    }),
    at
  )
}

export interface IssueChange {
  title?: string
  description?: string
  addLabels?: readonly string[]
  removeLabels?: readonly string[]
  stateEvent?: 'close' | 'reopen'
}

/** One `PUT` with what changes and nothing else. */
export async function updateIssue(
  path: string,
  iid: number,
  change: IssueChange,
  o: GitlabApiOptions
): Promise<GitlabIssue> {
  const at = `${issuesOf(path)}/${iid}`
  const payload: Record<string, string> = {}
  if (change.title !== undefined) payload['title'] = change.title
  if (change.description !== undefined)
    payload['description'] = change.description
  if (change.addLabels !== undefined && change.addLabels.length > 0)
    payload['add_labels'] = change.addLabels.join(',')
  if (change.removeLabels !== undefined && change.removeLabels.length > 0)
    payload['remove_labels'] = change.removeLabels.join(',')
  if (change.stateEvent !== undefined)
    payload['state_event'] = change.stateEvent
  return issueOrFail(await gitlabCall('PUT', at, o, payload), at)
}

/** An issue by its iid; null when the project has none. */
export async function issue(
  path: string,
  iid: number,
  o: GitlabApiOptions
): Promise<GitlabIssue | null> {
  const at = `${issuesOf(path)}/${iid}`
  const answer = await gitlabCall('GET', at, o)
  if (answer.status === 404) return null
  return issueOrFail(answer, at)
}

/** Every issue carrying all of `labels`, in `state` (`opened`, `closed`, `all`), page by page. */
export async function listIssues(
  path: string,
  filter: { labels?: readonly string[]; state?: 'opened' | 'closed' | 'all' },
  o: GitlabApiOptions
): Promise<GitlabIssue[]> {
  const at = issuesOf(path)
  const listed = await pages(
    at,
    {
      ...(filter.labels === undefined
        ? {}
        : { labels: filter.labels.join(',') }),
      state: filter.state ?? 'all',
      order_by: 'created_at',
      sort: 'asc',
    },
    o
  )
  if (listed === null)
    throw new Error(
      `GitLab has no project ${path} (or it is not visible to you)`
    )
  return listed.items.map(toIssue).filter((i): i is GitlabIssue => i !== null)
}

/** The project's labels, by name and colour. */
export async function labels(
  path: string,
  o: GitlabApiOptions
): Promise<{ name: string; color: string }[]> {
  const listed = await pages(`/projects/${segment(path)}/labels`, {}, o)
  if (listed === null)
    throw new Error(
      `GitLab has no project ${path} (or it is not visible to you)`
    )
  const out: { name: string; color: string }[] = []
  for (const l of listed.items) {
    const name = field(l, 'name')
    const color = field(l, 'color')
    if (typeof name === 'string')
      out.push({ name, color: typeof color === 'string' ? color : '' })
  }
  return out
}

/** A label of the project; `color` as hex, with or without its `#`. */
export async function createLabel(
  path: string,
  label: { name: string; color: string; description?: string },
  o: GitlabApiOptions
): Promise<void> {
  const at = `/projects/${segment(path)}/labels`
  const answer = await gitlabCall('POST', at, o, {
    name: label.name,
    color: label.color.startsWith('#') ? label.color : `#${label.color}`,
    ...(label.description === undefined
      ? {}
      : { description: label.description }),
  })
  if (answer.status !== 201) throw failure(answer, at)
}

/** A note (GitLab's comment) on an issue. */
export async function note(
  path: string,
  iid: number,
  body: string,
  o: GitlabApiOptions
): Promise<void> {
  const at = `${issuesOf(path)}/${iid}/notes`
  const answer = await gitlabCall('POST', at, o, { body })
  if (answer.status !== 201) throw failure(answer, at)
}

/**
 * The issue `iid` of `path` related to `targetIid` of `targetPath`: Free's
 * link between two issues, shown on both (spec 0037 §6, the journal).
 */
export async function link(
  path: string,
  iid: number,
  targetPath: string,
  targetIid: number,
  o: GitlabApiOptions
): Promise<void> {
  const at = `${issuesOf(path)}/${iid}/links`
  const answer = await gitlabCall('POST', at, o, {
    target_project_id: targetPath,
    target_issue_iid: targetIid,
    link_type: 'relates_to',
  })
  if (answer.status !== 201 && answer.status !== 200) throw failure(answer, at)
}

/** The latest merge request from `branch`: its iid and state, `locked` read as `opened`; null when none. */
export async function mergeRequest(
  path: string,
  branch: string,
  o: GitlabApiOptions
): Promise<{ iid: number; state: string } | null> {
  const q = new URLSearchParams({
    source_branch: branch,
    order_by: 'updated_at',
    sort: 'desc',
    per_page: '1',
  })
  const at = `/projects/${segment(path)}/merge_requests`
  const answer = await gitlabCall('GET', `${at}?${q}`, o)
  if (answer.status !== 200 || !Array.isArray(answer.body))
    throw failure(answer, at)
  const first: unknown = answer.body[0]
  const iid = field(first, 'iid')
  const state = field(first, 'state')
  if (typeof iid !== 'number' || typeof state !== 'string') return null
  return { iid, state: state === 'locked' ? 'opened' : state }
}
