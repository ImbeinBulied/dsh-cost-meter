// TEST-ONLY pins for the isolation helpers (the in-process fixture and the NODE_OPTIONS preload).
// Purpose: the two helpers must agree on the key set, the marker and the root layout, and a
// hostile inherited USERPROFILE must never survive into a child process — product code resolves the
// home directory as `USERPROFILE || HOME` (lib/index.js findGoKeyInAuthJson / findAnthropicOAuthToken),
// so an unredirected USERPROFILE would read the real user's credential files.
//
// Every path used here is synthetic (temp dirs, literal delimiters, no user data); nothing is
// imported from lib/* before the isolation fixtures are active.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failClosedFetch, isGeneratedRoot, KEYS, MARKER, syntheticEnv } from './helpers/synthetic-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PRELOAD = join(HERE, 'helpers', 'isolated-run.mjs')
// Synthetic marker values for the scrub proof. CREDENTIAL_NAME is deliberately credential-shaped
// (`*_KEY`) with a synthetic value: the preload must delete the NAME before any child module loads.
// KEEP_NAME is non-credential-shaped and must survive, so the assertion cannot pass by dropping the
// whole environment. Neither value is a real credential or real path.
const CREDENTIAL_NAME = 'ANTHROPIC_API_KEY'
const CREDENTIAL_VALUE = 'dsh-fork-isolation-credential-probe'
const KEEP_NAME = 'DSH_TEST_ISOLATION_SENTINEL'
const KEEP_VALUE = 'dsh-fork-isolation-keep-probe'
const HOSTILE_PROFILE = join(tmpdir(), 'dsh-hostile-userprofile-synthetic', 'windows-home')
const HOSTILE_MARKER = join(tmpdir(), 'dsh-hostile-inherited-marker-synthetic')

/** Run a child and return its single JSON line; the child environment is exactly what is passed. */
function childJson(source, env) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `child exited ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 200)}`)
  const line = String(result.stdout).trim().split('\n').filter(Boolean).pop()
  assert.ok(line, 'child produced no output line')
  return JSON.parse(line)
}

const preloadEnv = extra => ({ HOME: '/', PATH: process.env.PATH, NODE_OPTIONS: `--import ${PRELOAD}`, ...extra })
// A child removes its own root on exit, so the parent classifies the reported path (a string
// predicate). `isGeneratedRoot` (filesystem) is used only for roots that must exist right now.
const generatedRootPath = path => String(path ?? '').startsWith(join(tmpdir(), `dsh-fork-test-`))
const PRELOAD_SNAPSHOT = `import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const keys = {
${KEYS.map(key => `  ${JSON.stringify(key)}: process.env[${JSON.stringify(key)}] ?? null,`).join('\n')}
}
const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-fork-cwd-'))
let relocated = null
try {
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.env.HOME ?? "unset")'], { cwd: elsewhere, env: process.env, encoding: 'utf8' })
  const nested = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({ root: process.env.DSH_FORK_TEST_ROOT ?? null }))'], { env: process.env, encoding: 'utf8' })
  relocated = {
    home: String(child.stdout).trim(),
    status: child.status,
    nestedRoot: nested.status === 0 ? JSON.parse(String(nested.stdout).trim()).root : null,
  }
} finally {
  rmSync(elsewhere, { recursive: true, force: true })
}
console.log(JSON.stringify({
  marker: process.env['${MARKER}'] ?? null,
  live: process.env.DSH_TEST_LIVE_PRICING ?? null,
  credentialNamePresent: '${CREDENTIAL_NAME}' in process.env,
  credentialValuePresent: process.env['${CREDENTIAL_NAME}'] === '${CREDENTIAL_VALUE}',
  keepNamePresent: process.env['${KEEP_NAME}'] === '${KEEP_VALUE}',
  keys,
  relocated,
}))`

test('preload redirects HOME/USERPROFILE before any child module loads, even when inherited hostile', () => {
  // Fresh root, with a synthetic credential-shaped name and a non-credential sentinel injected:
  // hostile USERPROFILE must not survive, and every synthetic key must move together.
  const fresh = childJson(PRELOAD_SNAPSHOT, preloadEnv({
    [MARKER]: HOSTILE_MARKER,   // foreign marker must be ignored (this path is not a generated root)
    USERPROFILE: HOSTILE_PROFILE,
    [CREDENTIAL_NAME]: CREDENTIAL_VALUE,
    [KEEP_NAME]: KEEP_VALUE,
  }))
  const root = fresh.marker
  assert.ok(root && generatedRootPath(root), `preload created a generated root, got ${root}`)
  assert.ok(!String(root).includes('hostile'), 'hostile marker value did not become the root')
  assert.notEqual(root, HOSTILE_MARKER, 'foreign marker is not trusted')
  // Every key the fixture relies on points at the synthetic root, and the hostile USERPROFILE is gone.
  assert.equal(fresh.keys.HOME, root, 'HOME points at the synthetic root')
  assert.equal(fresh.keys.USERPROFILE, root, 'USERPROFILE points at the synthetic root (product home)')
  assert.equal(fresh.keys.DSH_HOME, join(root, 'dsh_home'), 'DSH_HOME points inside the synthetic root')
  assert.equal(fresh.keys.XDG_CONFIG_HOME, join(root, 'xdg_config_home'), 'XDG_* points inside the synthetic root')
  assert.notEqual(fresh.keys.USERPROFILE, HOSTILE_PROFILE, 'hostile inherited USERPROFILE was not redirected')
  for (const key of KEYS) assert.equal(typeof fresh.keys[key], 'string', `preload set ${key}`)
  assert.equal(fresh.live, '0', 'live pricing forced off for the child')
  // Credential-name scrub, both directions: the injected credential-shaped NAME is gone before any
  // child module could read it, while the non-credential sentinel survives (so a wholesale env wipe
  // cannot satisfy the assertion).
  assert.equal(fresh.credentialNamePresent, false, `${CREDENTIAL_NAME} name absent after preload`)
  assert.equal(fresh.credentialValuePresent, false, `${CREDENTIAL_NAME} value gone with the name`)
  assert.equal(fresh.keepNamePresent, true, `${KEEP_NAME} non-credential sentinel survived (env not wholesale-dropped)`)

  // A live child's own children (a) reuse the root instead of making a second one, and
  // (b) keep the synthetic HOME even when their cwd is elsewhere (absolute NODE_OPTIONS).
  assert.equal(fresh.relocated.status, 0, 'cwd-relocated child exited successfully')
  assert.equal(fresh.relocated.home, root, 'cwd-relocated child keeps the synthetic HOME')
  assert.equal(fresh.relocated.nestedRoot, root, 'live nested child reuses the inherited root')

  // The root for this test process lives nowhere but the temp dir, and the hostile marker is untouched.
  assert.ok(generatedRootPath(syntheticEnv().root), 'fixture root is a generated temp dir')
  assert.ok(!existsSync(HOSTILE_MARKER), 'foreign marker path was never created')
})

test('in-process fixture reuses the preload root and creates its own layout when standalone', async () => {
  const fixture = syntheticEnv()
  const snapshot = {
    root: fixture.root,
    home: process.env.HOME,
    userprofile: process.env.USERPROFILE,
    dshHome: process.env.DSH_HOME,
  }
  assert.ok(isGeneratedRoot(fixture.root), 'fixture root is a generated temp dir')
  assert.equal(snapshot.home, fixture.root, 'fixture HOME == root')
  assert.equal(snapshot.userprofile, fixture.root, 'fixture USERPROFILE == root (product home on Windows)')
  assert.equal(snapshot.dshHome, join(fixture.root, 'dsh_home'), 'fixture DSH_HOME is inside the root')

  // Standalone (no preload): importing the helper must itself redirect, then clean up on exit.
  const standaloneRoot = mkdtempSync(join(tmpdir(), 'dsh-fork-standalone-'))
  const source = `const { syntheticEnv } = await import(${JSON.stringify(resolve(HERE, 'helpers', 'synthetic-env.mjs'))})
const env = syntheticEnv()
console.log(JSON.stringify({
  root: env.root,
  home: process.env.HOME ?? null,
  userprofile: process.env.USERPROFILE ?? null,
  dshHome: process.env.DSH_HOME ?? null,
  xdgConfig: process.env.XDG_CONFIG_HOME ?? null,
}))`
  try {
    const standalone = childJson(source, {
      HOME: standaloneRoot,
      PATH: process.env.PATH,
    })
    assert.ok(generatedRootPath(standalone.root), 'standalone fixture created a generated temp root')
    assert.notEqual(standalone.userprofile, standaloneRoot, 'standalone fixture redirected USERPROFILE away from the inherited home')
    assert.equal(standalone.userprofile, standalone.root, 'standalone fixture USERPROFILE == its root')
    assert.equal(standalone.home, standalone.root, 'standalone fixture HOME == its root')
    assert.equal(standalone.dshHome, join(standalone.root, 'dsh_home'), 'standalone fixture DSH_HOME is inside its root')
    assert.equal(standalone.xdgConfig, join(standalone.root, 'xdg_config_home'), 'standalone fixture redirects XDG_*')
    // standalone is asserted dead only after its JSON line: the creator-only cleanup removes the tree.
    assert.equal(existsSync(standalone.root), false, 'standalone fixture cleaned up its root on exit')
  } finally {
    rmSync(standaloneRoot, { recursive: true, force: true })
  }

  // The strict in-process guard still denies even loopback (preload allows loopback, failClosedFetch does not).
  const restore = failClosedFetch()
  try {
    await assert.rejects(globalThis.fetch('http://127.0.0.1:9/x'), /Network access is forbidden in fork tests/)
  } finally {
    restore()
  }
})
