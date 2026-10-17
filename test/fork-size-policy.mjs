// TEST-ONLY boundary proof for the shared byte policy (scripts/size-policy.mjs).
// Pure policy math: no runtime I/O, no network, no product import — running it under the
// isolation preload is harmless and is what the Step 9 gate command does (CI wiring: Task 10).
//
// Two distinct bounds are deliberate: the STORE bound (262,144) still governs every source
// fragment and chunk artifact, while the generated main bundle uses the fork ceiling (294,912)
// documented in README "Distribution & size note (fork)" and at both gate sites.
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkMainBundle, checkSourceFile, MAIN_BUNDLE_LIMIT, STORE_FILE_LIMIT } from '../scripts/size-policy.mjs'

test('main bundle policy accepts the current bundle and rejects one byte over the ceiling', () => {
  assert.equal(checkMainBundle(262096).ok, true)               // measured size of lib/client.js at this task's baseline
  assert.equal(checkMainBundle(272038).ok, true)               // historical fixture: the bundle size after the client ports; stays valid under any limit >= 272038
  assert.equal(checkMainBundle(MAIN_BUNDLE_LIMIT).ok, true)    // exact boundary is accepted
  assert.equal(checkMainBundle(MAIN_BUNDLE_LIMIT + 1).ok, false)
  assert.equal(MAIN_BUNDLE_LIMIT, 294912)
})

test('source and chunk files keep the unchanged STORE bound', () => {
  assert.equal(checkSourceFile('src/client/02-validators-helpers-sidebar.js', 192061).ok, true)  // measured fragment size
  assert.equal(checkSourceFile('x.js', STORE_FILE_LIMIT).ok, true)
  assert.equal(checkSourceFile('x.js', STORE_FILE_LIMIT + 1).ok, false)
  assert.equal(STORE_FILE_LIMIT, 262144)
})
