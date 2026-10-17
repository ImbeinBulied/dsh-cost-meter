// TEST-ONLY (never shipped: the `files` allowlist excludes test/).
// Shared synthetic-root plumbing for BOTH isolation entry points:
//   - `test/helpers/isolated-run.mjs` (NODE_OPTIONS preload, runs before any child module loads)
//   - this module's in-process fixture `syntheticEnv()` (called by test bodies, after lib imports)
// The two must agree on the key set, the marker name and the root layout, so that logic lives here
// once. Only the fetch guards differ on purpose: the preload allows loopback (upstream suites start
// local servers), `failClosedFetch()` allows nothing.
//
// Importing this module has NO side effects: it neither touches process.env nor the network.
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

// DSH_FORK_TEST_ROOT is the inheritance marker (a synthetic root created below); the rest is the
// profile surface a test process may resolve credentials/storage through. USERPROFILE is included
// because product code prefers it over HOME (lib/index.js findGoKeyInAuthJson /
// findAnthropicOAuthToken: `process.env.USERPROFILE || process.env.HOME`), so on Windows an
// unredirected USERPROFILE reads the real user's opencode/Claude Code credential files.
export const KEYS = ['HOME', 'USERPROFILE', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
export const ROOT_PREFIX = 'dsh-fork-test-'
export const MARKER = 'DSH_FORK_TEST_ROOT'
// `HOME` and `USERPROFILE` point at the root itself (the path the product resolves as home);
// every other key gets its own generated subdirectory so real config paths cannot collide.
const HOME_KEYS = new Set(['HOME', 'USERPROFILE'])
const keyDir = (root, key) => (HOME_KEYS.has(key) ? root : join(root, key.toLowerCase()))

export function isGeneratedRoot(path) {
  try { return statSync(path).isDirectory() && path.startsWith(join(tmpdir(), ROOT_PREFIX)) } catch { return false }
}

/** True when `path` is inside `root` (so a root marker cannot smuggle real profile paths). */
function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

/**
 * An inherited marker is trusted only when the complete synthetic layout points inside the
 * generated root; a foreign/hostile `DSH_FORK_TEST_ROOT` is then ignored and redirected.
 */
export function isSyntheticLayout(root) {
  if (!isGeneratedRoot(root)) return false
  if (!KEYS.every(key => typeof process.env[key] === 'string' && process.env[key].length > 0 && isInside(root, process.env[key]))) return false
  return resolve(process.env.DSH_HOME) === resolve(join(root, 'dsh_home'))
}

/** Create the throwaway root and point every KEYS entry at it. Returns the root path. */
export function applySyntheticEnv() {
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX))
  for (const key of KEYS) {
    const dir = keyDir(root, key)
    mkdirSync(dir, { recursive: true })
    process.env[key] = dir
  }
  process.env[MARKER] = root
  return root
}

/** Idempotent: safe whether or not the creator or a test already removed the tree. */
export function cleanSyntheticRoot(root) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* already gone */ }
}

/**
 * Redirect HOME/USERPROFILE/DSH_HOME/XDG_* into a throwaway temp dir.
 * Reuses the preload's root when the inherited layout is intact; anything else is ignored and a
 * fresh root is created and cleaned up here.
 */
export function syntheticEnv() {
  if (isSyntheticLayout(process.env[MARKER])) {
    return { root: process.env[MARKER], restore() {} }   // preload already redirected
  }
  const previous = new Map()
  for (const key of KEYS) previous.set(key, process.env[key])
  const root = applySyntheticEnv()
  const clean = () => cleanSyntheticRoot(root)
  process.once('exit', clean)
  return {
    root,
    restore() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      clean()
    },
  }
}

/** Strict in-process guard: only an explicitly installed in-process mock may answer. */
export function failClosedFetch() {
  const original = globalThis.fetch
  globalThis.fetch = async url => {
    throw new Error('Network access is forbidden in fork tests: ' + String(url).slice(0, 80))
  }
  return () => { globalThis.fetch = original }
}
