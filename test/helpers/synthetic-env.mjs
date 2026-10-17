// TEST-ONLY (never shipped: the `files` allowlist excludes test/).
// Redirect HOME/DSH_HOME/XDG_* into a throwaway temp dir and install a fail-closed fetch guard,
// so no fork test can reach the real profile, credentials, sessions, or any external network.
// Reuses the preload's root when it is a validated generated temp dir; anything else is ignored.
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEYS = ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
const isGeneratedRoot = path => {
  try { return statSync(path).isDirectory() && path.startsWith(join(tmpdir(), 'dsh-fork-test-')) } catch { return false }
}

export function syntheticEnv() {
  if (isGeneratedRoot(process.env.DSH_FORK_TEST_ROOT)) {
    return { root: process.env.DSH_FORK_TEST_ROOT, restore() {} }   // preload already redirected
  }
  const root = mkdtempSync(join(tmpdir(), 'dsh-fork-test-'))
  const previous = new Map()
  for (const key of KEYS) {
    previous.set(key, process.env[key])
    const dir = key === 'HOME' ? root : join(root, key.toLowerCase())
    mkdirSync(dir, { recursive: true })
    process.env[key] = dir
  }
  process.env.DSH_FORK_TEST_ROOT = root
  const clean = () => rmSync(root, { recursive: true, force: true })
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
