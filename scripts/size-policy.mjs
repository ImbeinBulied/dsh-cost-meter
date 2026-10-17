// Shared byte policy for the generator and the verifier (single source of truth).
// STORE bound: unchanged for source fragments and on-demand chunk artifacts.
// Fork main-bundle ceiling: documented exception for the generated main artifact, Git-only
// distribution (see README "Distribution & size note (fork)"); same fail condition in both gates.
export const STORE_FILE_LIMIT = 262144
export const MAIN_BUNDLE_LIMIT = 294912

/** @returns {{ok: true} | {ok: false, message: string}} */
export function checkSourceFile(name, bytes) {
  return bytes <= STORE_FILE_LIMIT
    ? { ok: true }
    : { ok: false, message: `${name} exceeds ${STORE_FILE_LIMIT} bytes (${bytes})` }
}

export function checkMainBundle(bytes) {
  return bytes <= MAIN_BUNDLE_LIMIT
    ? { ok: true }
    : { ok: false, message: `lib/client.js exceeds the fork main-bundle ceiling (${MAIN_BUNDLE_LIMIT}, got ${bytes})` }
}
