import test from 'node:test'
import assert from 'node:assert/strict'
import * as webHost from '../lib/web-host.js'

test('exports either no Config or a standard-schema compatible Config', () => {
  assert.ok(
    !webHost.Config || typeof webHost.Config['~standard']?.validate === 'function',
    'Config must expose ~standard.validate when it is exported'
  )
})
