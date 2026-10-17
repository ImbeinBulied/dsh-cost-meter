// TEST-ONLY preload: `NODE_OPTIONS="--import /abs/path/test/helpers/isolated-run.mjs"`.
// Runs BEFORE any child module loads, so statically-importing suites (e.g. test/verify.mjs) see the
// synthetic environment from their very first import. Idempotent for nested node processes: a
// validated inherited root is reused and only the creator cleans it up.
//
// The root/key plumbing comes from `./synthetic-env.mjs` (same key set, same layout, same marker),
// so the preload and the in-process fixture cannot drift apart. Only the fetch guards differ on
// purpose: this preload allows loopback (upstream suites start local servers); the fixture's
// `failClosedFetch()` allows nothing.
//
// Scope: this is NOT an OS/network sandbox. It deletes credential-valued env NAMES (values are
// never read), redirects HOME/USERPROFILE/DSH_HOME/XDG_* and blocks `globalThis.fetch` for
// non-loopback hosts. A suite that bypasses fetch with raw sockets is not covered — inspect for
// that and report the gap instead of assuming coverage.
import { cleanSyntheticRoot, isGeneratedRoot, applySyntheticEnv, KEYS, MARKER } from './synthetic-env.mjs'

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
// Credential-shaped env NAMES (names only; values are never read or printed). The suffix set must
// cover every name the product actually resolves — `lib/coding-plans.js` credentialEnvs /
// credentialEnvsSecret include the volcengine AK/SK aliases VOLC_ACCESSKEY, VOLC_SECRETKEY,
// VOLCENGINE_ACCESS_KEY_ID and ARK_ACCESS_KEY_ID, which a bare `_KEY`/`_SECRET` suffix misses.
const CREDENTIAL_ENV = /^(?:GH_|GITHUB_|GLAB_)|(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_COOKIE|_AUTH|ACCESSKEY|SECRETKEY|ACCESS_KEY_ID)$/u

if (!isGeneratedRoot(process.env[MARKER])) {
  const root = applySyntheticEnv()
  process.once('exit', () => cleanSyntheticRoot(root))   // creator cleans up only
}
// Clear credential-valued env NAMES before any child module can read them (names only; no values
// are read or printed). DSH_TEST_NODE_MODULES and the synthetic keys stay.
for (const key of Object.keys(process.env)) {
  if (key === MARKER || KEYS.includes(key)) continue
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

// Opt-in only (Task-7-11 evidence wrapper): make a gate log prove its own preload activation.
if (process.env.DSH_TEST_ISOLATION_TRACE === '1') {
  console.error(`[fork-preload] synthetic root ${process.env[MARKER]} (HOME/USERPROFILE/DSH_HOME/XDG_* redirected, non-loopback fetch blocked)`)
}
