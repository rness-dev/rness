import assert from 'node:assert/strict'
import { test } from 'node:test'

import { repositoryStatusOf } from '../../src/core/repository-status.ts'

// Whether a repository exists, read off the API's status code, never off its
// wording (the maintainer, 2026-11-02, plan 0053 task 7).

test('200 is found, 404 is not found', () => {
  assert.deepEqual(repositoryStatusOf(200, 'GitHub', 'acme/.rness'), {
    kind: 'found',
  })
  assert.deepEqual(repositoryStatusOf(404, 'GitHub', 'acme/.rness'), {
    kind: 'not-found',
  })
})

test('401, 403 and anything else are errors that name the host, the repository and the code', () => {
  assert.deepEqual(repositoryStatusOf(401, 'GitLab', 'acme/rness'), {
    kind: 'error',
    status: 401,
    message: 'GitLab refused the token (401)',
  })
  assert.deepEqual(repositoryStatusOf(403, 'Bitbucket', 'acme/.rness'), {
    kind: 'error',
    status: 403,
    message: 'no access to acme/.rness on Bitbucket (403)',
  })
  assert.deepEqual(repositoryStatusOf(500, 'GitHub', 'acme/.rness'), {
    kind: 'error',
    status: 500,
    message: 'GitHub answered 500 for acme/.rness',
  })
})
