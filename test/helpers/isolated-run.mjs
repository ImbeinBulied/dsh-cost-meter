// TEST-ONLY preload: `NODE_OPTIONS="--import /abs/path/test/helpers/isolated-run.mjs"`.
// Runs BEFORE any child module loads, so statically-importing suites (e.g. test/verify.mjs) see the
// synthetic environment from their very first import. Idempotent for nested node processes: a
// validated inherited root is reused and only the creator cleans it up.
//
// Scope: this is NOT an OS/network sandbox. It deletes credential-valued env NAMES (values are
// never read), redirects HOME/DSH_HOME/XDG_* and blocks `globalThis.fetch` for non-loopback hosts.
// A suite that bypasses fetch with raw sockets is not covered — inspect for that and report the
// gap instead of assuming coverage.
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEYS = ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const CREDENTIAL_ENV = /^(?:GH_|GITHUB_|GLAB_)|(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_COOKIE|_AUTH)$/u
const isGeneratedRoot = path => {
  try { return statSync(path).isDirectory() && path.startsWith(join(tmpdir(), 'dsh-fork-test-')) } catch { return false }
}

if (!isGeneratedRoot(process.env.DSH_FORK_TEST_ROOT)) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fork-test-'))
  for (const key of KEYS) {
    const dir = key === 'HOME' ? root : join(root, key.toLowerCase())
    mkdirSync(dir, { recursive: true })
    process.env[key] = dir
  }
  process.env.DSH_FORK_TEST_ROOT = root
  process.once('exit', () => rmSync(root, { recursive: true, force: true }))   // creator cleans up only
}
// Clear credential-valued env NAMES before any child module can read them (names only; no values
// are read or printed). DSH_TEST_NODE_MODULES and the synthetic keys stay.
for (const key of Object.keys(process.env)) {
  if (key === 'DSH_FORK_TEST_ROOT') continue
  if (CREDENTIAL_ENV.test(key)) delete process.env[key]
}
process.env.DSH_TEST_LIVE_PRICING = '0'   // the pinned verify.mjs opts into live pricing only on '1'

const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !LOOPBACK.has(url.hostname)) {
    throw new Error('external network blocked by fork preload: ' + url.hostname)
  }
  return originalFetch(input, init)   // loopback stays available for the suites' own local servers
}
