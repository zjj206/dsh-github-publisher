import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PreviewStore,
  buildRepoSlug,
  defaultRepositoryName,
  expectedConfirmation,
  findBlockedPaths,
  fingerprint,
  normalizeOwner,
  normalizeRepoName,
  normalizeTag
} from '../lib/core.js'

test('normalizes safe GitHub names and tags', () => {
  assert.equal(normalizeRepoName(' fish-project '), 'fish-project')
  assert.equal(normalizeOwner('deepseek-ai'), 'deepseek-ai')
  assert.equal(normalizeTag('v1.0.0'), 'v1.0.0')
  assert.equal(buildRepoSlug('deepseek-ai', 'fish-project'), 'deepseek-ai/fish-project')
})

test('derives a safe repository name from the project folder', () => {
  assert.equal(defaultRepositoryName('D:\\projects\\My Cool App!'), 'my-cool-app')
  assert.equal(defaultRepositoryName('/workspace/fish_tools'), 'fish_tools')
})

test('rejects unsafe repository and tag inputs', () => {
  assert.throws(() => normalizeRepoName('../oops'))
  assert.throws(() => normalizeOwner('-owner'))
  assert.throws(() => normalizeTag('bad tag'))
  assert.throws(() => normalizeTag('main..next'))
})

test('blocks common credential paths but not examples', () => {
  const blocked = findBlockedPaths([
    '.env',
    'config/.env.production',
    'deploy/id_rsa',
    'certs/server.key',
    '.aws/credentials',
    'src/index.js',
    '.env.example'
  ])
  assert.deepEqual(blocked.map((item) => item.path), [
    '.env',
    'config/.env.production',
    'deploy/id_rsa',
    'certs/server.key',
    '.aws/credentials'
  ])
})

test('preview tokens are one-use, typed, and expiring', () => {
  let now = 1000
  const store = new PreviewStore(500, () => now)
  const publish = store.create('publish', { repo: 'fish' })
  assert.deepEqual(store.consume(publish, 'publish'), { repo: 'fish' })
  assert.throws(() => store.consume(publish, 'publish'), /invalid, expired, already used/)

  const release = store.create('release', { tag: 'v1' })
  assert.throws(() => store.consume(release, 'publish'), /another action/)

  const expired = store.create('publish', { repo: 'old' })
  now += 501
  assert.throws(() => store.consume(expired, 'publish'), /expired/)
})

test('confirmation and fingerprints are deterministic', () => {
  assert.equal(expectedConfirmation('fish/demo', 'public', 'v1.0.0'), 'PUBLISH fish/demo public v1.0.0')
  assert.equal(fingerprint(['a', 'b']), fingerprint(['a', 'b']))
  assert.notEqual(fingerprint(['a', 'b']), fingerprint(['b', 'a']))
})
