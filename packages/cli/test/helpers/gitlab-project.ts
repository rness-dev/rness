import type { TestContext } from 'node:test'

import type { Recorded, Reply } from './fake-github.ts'
import { fakeGitlab } from './fake-gitlab.ts'

/**
 * gitlab.com holding one group's context project `<group>/rness`, with state:
 * its labels, its issue boards and their lists, its issues. Enough REST v4
 * for `rness board push`, the hooks and `rness note` (spec 0037 §6, §7), as
 * plan 0049 task 1 saw gitlab.com answer. Every request is recorded.
 */
export interface FakeIssue {
  iid: number
  title: string
  description: string
  labels: string[]
  state: 'opened' | 'closed'
}

export interface FakeBoard {
  id: number
  name: string
  hide_backlog_list: boolean
  hide_closed_list: boolean
  lists: { id: number; position: number; label: { id: number; name: string } }[]
}

export interface FakeProject {
  base: string
  requests: Recorded[]
  labels: { id: number; name: string; color: string }[]
  boards: FakeBoard[]
  issues: FakeIssue[]
  /** Writes to issues: what a second push must not make. */
  issueWrites(): Recorded[]
}

const csv = (v: unknown): string[] =>
  typeof v === 'string' && v !== '' ? v.split(',') : []

export async function gitlabProject(
  t: TestContext,
  group = 'acme'
): Promise<FakeProject> {
  const project = `/api/v4/projects/${encodeURIComponent(`${group}/rness`)}`
  let next = 100
  const state: Omit<FakeProject, 'base' | 'requests' | 'issueWrites'> = {
    labels: [],
    boards: [],
    issues: [],
  }
  const route = (r: Recorded): Reply => {
    const url = new URL(r.path, 'http://x')
    const path = url.pathname
    const body = (r.body ?? {}) as Record<string, unknown>
    if (path === '/oauth/token/info')
      return { json: { scope: ['api', 'write_repository'] } }
    if (path === '/api/v4/user') return { json: { id: 1, username: 'cedric' } }
    if (path === project)
      return { json: { id: 7, issues_access_level: 'enabled' } }
    if (path === `${project}/labels`) {
      if (r.method === 'GET') return { json: state.labels }
      const label = {
        id: next++,
        name: String(body['name']),
        color: String(body['color']),
      }
      state.labels.push(label)
      return { status: 201, json: label }
    }
    if (path === `${project}/boards`) {
      if (r.method === 'GET') return { json: state.boards }
      const board: FakeBoard = {
        id: next++,
        name: String(body['name']),
        hide_backlog_list: false,
        hide_closed_list: false,
        lists: [],
      }
      state.boards.push(board)
      return { status: 201, json: board }
    }
    const boardAt = /^.*\/boards\/(\d+)(?:\/lists(?:\/(\d+))?)?$/.exec(path)
    if (boardAt !== null && path.startsWith(project)) {
      const board = state.boards.find((b) => b.id === Number(boardAt[1]))
      if (board === undefined) return { status: 404, json: {} }
      if (boardAt[2] !== undefined) {
        const list = board.lists.find((l) => l.id === Number(boardAt[2]))
        if (list === undefined) return { status: 404, json: {} }
        if (r.method === 'DELETE') {
          board.lists = board.lists.filter((l) => l !== list)
          return { json: {} }
        }
        const to = Number(body['position'])
        board.lists = board.lists.filter((l) => l !== list)
        board.lists.splice(to, 0, list)
        board.lists.forEach((l, i) => (l.position = i))
        return { json: list }
      }
      if (path.endsWith('/lists')) {
        const label = state.labels.find(
          (l) => l.id === Number(body['label_id'])
        )
        if (label === undefined) return { status: 404, json: {} }
        const list = {
          id: next++,
          position: board.lists.length,
          label: { id: label.id, name: label.name },
        }
        board.lists.push(list)
        return { status: 201, json: list }
      }
      if (typeof body['hide_backlog_list'] === 'boolean')
        board.hide_backlog_list = body['hide_backlog_list']
      if (typeof body['hide_closed_list'] === 'boolean')
        board.hide_closed_list = body['hide_closed_list']
      return { json: board }
    }
    if (path === `${project}/issues`) {
      if (r.method === 'GET') {
        const wanted = csv(url.searchParams.get('labels'))
        const s = url.searchParams.get('state') ?? 'all'
        return {
          json: state.issues.filter(
            (i) =>
              wanted.every((l) => i.labels.includes(l)) &&
              (s === 'all' || i.state === s)
          ),
        }
      }
      const issue: FakeIssue = {
        iid: state.issues.length + 1,
        title: String(body['title']),
        description: String(body['description'] ?? ''),
        labels: csv(body['labels']),
        state: 'opened',
      }
      state.issues.push(issue)
      return { status: 201, json: issue }
    }
    const issueAt = new RegExp(`^${project}/issues/(\\d+)$`).exec(path)
    if (issueAt !== null) {
      const issue = state.issues.find((i) => i.iid === Number(issueAt[1]))
      if (issue === undefined) return { status: 404, json: {} }
      if (r.method === 'PUT') {
        if (typeof body['title'] === 'string') issue.title = body['title']
        if (typeof body['description'] === 'string')
          issue.description = body['description']
        const add = csv(body['add_labels'])
        const remove = csv(body['remove_labels'])
        issue.labels = [
          ...issue.labels.filter((l) => !remove.includes(l)),
          ...add.filter(
            (l) => !issue.labels.includes(l) && !remove.includes(l)
          ),
        ]
        if (body['state_event'] === 'close') issue.state = 'closed'
        if (body['state_event'] === 'reopen') issue.state = 'opened'
      }
      return { json: issue }
    }
    if (/\/issues\/\d+\/notes$/.test(path)) return { status: 201, json: {} }
    return { status: 404, json: { message: `no fake route for ${path}` } }
  }
  const host = await fakeGitlab(t, route)
  return {
    base: host.base,
    requests: host.requests,
    get labels() {
      return state.labels
    },
    get boards() {
      return state.boards
    },
    get issues() {
      return state.issues
    },
    issueWrites: () =>
      host.requests.filter(
        (r) =>
          (r.method === 'POST' || r.method === 'PUT') &&
          r.path.includes('/issues')
      ),
  }
}
