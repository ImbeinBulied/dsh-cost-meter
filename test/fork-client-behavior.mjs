// TEST-ONLY: Task 7 -- window picker helpers + Chinese balance-prefix locale fallback.
//
// The browser client is one factory closure shipped as generated lib/client.js; the readable edit
// surface is src/client/*.js. These tests extract the real helper definitions from those fragments
// and execute them (no reimplementation in the test), so a rename or a dropped guard fails here.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { failClosedFetch, syntheticEnv } from './helpers/synthetic-env.mjs'

const env = syntheticEnv()
const restoreFetch = failClosedFetch()
process.once('exit', restoreFetch)

// Fragments are the edit surface; lib/client.js is generated. Tests read the readable source.
const root = fileURLToPath(new URL('..', import.meta.url))
const lib = file => import(pathToFileURL(join(root, 'lib', file)).href)
// Imported only AFTER the isolation setup above. The real sanitizer supplies the config shapes the
// browser receives; Task 9 needs both for the classifier/backfill tests.
const { defaultConfig, sanitizeConfig } = await lib('store.js')
assert.equal(typeof sanitizeConfig, 'function', 'lib/store.js exports sanitizeConfig for later tasks')
assert.equal(typeof defaultConfig, 'function', 'lib/store.js exports defaultConfig for later tasks')
assert.equal(typeof env.root, 'string', 'synthetic env root is established before any lib import')

const clientFiles = readdirSync(join(root, 'src/client')).filter(n => n.endsWith('.js')).sort()
const clientSource = clientFiles.map(n => readFileSync(join(root, 'src/client', n), 'utf8')).join('')

function balanced(source, at) {
  let depth = 0
  for (let i = source.indexOf('{', at); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(at, i + 1) }
  }
  throw new Error('unbalanced braces')
}
function fn(name) {
  const at = clientSource.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `client source defines ${name}()`)
  return balanced(clientSource, at)
}
/** Lexical bindings the extracted helpers reference (e.g. the storage key). */
function constLiteral(source, name) {
  const match = source.match(new RegExp(`const ${name} = '[^']*'`))
  assert.ok(match, `client source defines ${name} as a string literal`)
  return match[0]
}
const evalFns = (source, names) => new Function(`${source}\nreturn { ${names.join(', ')} }`)()
/** Same extraction, but with a controlled `window` (the helpers resolve window.localStorage). */
const evalFnsWithWindow = (source, names, windowShim) =>
  new Function('window', `${source}\nreturn { ${names.join(', ')} }`)(windowShim)

/** localStorage shim: the helpers accept an injected storage in tests, window.localStorage in the app. */
const mapStorage = map => ({
  getItem: key => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
})

/**
 * A window whose `localStorage` is a throwing PROPERTY GETTER — a browser with storage disabled can
 * throw when the property itself is obtained, before any getItem/setItem call. `reads` counts how
 * often the helper actually reached the getter, so the test proves the case is exercised.
 */
function deniedStorageWindow() {
  let reads = 0
  const shim = {}
  Object.defineProperty(shim, 'localStorage', {
    get() { reads += 1; throw new Error('synthetic storage getter denied') },
  })
  return { shim, reads: () => reads }
}

test('window picker selection round-trips through the storage format and filters entries', () => {
  const picker = evalFns(
    [constLiteral(clientSource, 'windowPickKey'), fn('windowPickOf'), fn('windowPickSet'), fn('windowPickEntries')].join('\n'),
    ['windowPickOf', 'windowPickSet', 'windowPickEntries'],
  )
  const map = new Map()
  const storage = mapStorage(map)
  const entries = [['fiveHour', {}], ['weekly', {}], ['monthly', {}]]
  assert.equal(picker.windowPickOf('commandcode', storage), null, 'absent key = default (null)')
  assert.deepEqual(picker.windowPickEntries(entries, 'commandcode', storage), entries)
  picker.windowPickSet('commandcode', 'monthly,fiveHour', storage) // persisted string format
  assert.equal(map.get('dsh-cost-meter.windowPick'), '{"commandcode":"monthly,fiveHour"}')
  assert.deepEqual(picker.windowPickOf('commandcode', storage), ['monthly', 'fiveHour'])
  assert.deepEqual(picker.windowPickEntries(entries, 'commandcode', storage), [['monthly', {}], ['fiveHour', {}]])
  picker.windowPickSet('commandcode', 'all', storage)
  assert.equal(map.get('dsh-cost-meter.windowPick'), '{"commandcode":"all"}')
  assert.equal(picker.windowPickOf('commandcode', storage), 'all')
  assert.deepEqual(picker.windowPickEntries(entries, 'commandcode', storage), entries, 'all = every window')
  picker.windowPickSet('failopen', '', storage)
  assert.equal(picker.windowPickOf('failopen', storage), null, 'empty string = default')
  assert.equal(picker.windowPickOf('unknown-plan', storage), null, 'unknown plan key = default')
  // Regression guard: the picker's non-pick entry must survive a write for another plan.
  assert.equal(JSON.parse(map.get('dsh-cost-meter.windowPick')).commandcode, 'all')
  picker.windowPickSet('commandcode', null, storage)
  assert.equal(map.get('dsh-cost-meter.windowPick'), '{"failopen":""}', 'only the addressed plan key is removed')
  assert.equal(picker.windowPickOf('commandcode', storage), null)
  assert.deepEqual(picker.windowPickEntries(entries, 'commandcode', storage), entries)
  map.set('dsh-cost-meter.windowPick', '{not json')
  assert.equal(picker.windowPickOf('commandcode', storage), null, 'corrupt JSON fails open to default')
  assert.equal(picker.windowPickSet('commandcode', 'weekly', { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }), undefined, 'storage denial is swallowed')
  const lockedStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.deepEqual(picker.windowPickEntries(entries, 'commandcode', lockedStorage), entries, 'unreadable storage renders every window')
})

test('a throwing localStorage property getter cannot escape the picker helpers', () => {
  // Regression (I1): the helpers used to default `storage = window.localStorage` in their parameter
  // list, so the getter ran OUTSIDE the guard and a SecurityError escaped into the render path. The
  // canonical helpers — and these again — obtain window.localStorage inside `try`. The throwing case
  // above (methods that throw) cannot observe this: the property getter has to throw.
  const names = ['windowPickOf', 'windowPickSet', 'windowPickEntries']
  const source = [constLiteral(clientSource, 'windowPickKey'), ...names.map(fn)].join('\n')
  const denied = deniedStorageWindow()
  const picker = evalFnsWithWindow(source, names, denied.shim)
  const entries = [['fiveHour', {}], ['weekly', {}]]
  assert.equal(picker.windowPickOf('anthropic'), null, 'an unreadable property getter = default pick')
  assert.equal(picker.windowPickSet('anthropic', 'weekly'), undefined, 'a denied write is swallowed')
  assert.deepEqual(picker.windowPickEntries(entries, 'anthropic'), entries, 'the entries path catches the getter through windowPickOf')
  assert.ok(denied.reads() > 0, 'the throwing property getter was actually reached (the case is causal)')
  // Preserved seam and fallbacks: an injected storage bypasses window.localStorage entirely, and an
  // explicitly broken/invalid storage still fails open.
  const before = denied.reads()
  const map = new Map()
  const storage = mapStorage(map)
  assert.equal(picker.windowPickOf('anthropic', storage), null)
  picker.windowPickSet('anthropic', 'weekly', storage)
  assert.equal(map.get('dsh-cost-meter.windowPick'), '{"anthropic":"weekly"}', 'the injected storage still round-trips')
  assert.deepEqual(picker.windowPickEntries(entries, 'anthropic', storage), [['weekly', {}]])
  assert.equal(denied.reads(), before, 'an injected storage never touches window.localStorage')
  assert.equal(picker.windowPickOf('anthropic', null), null, 'a broken injected storage fails open')
  assert.deepEqual(picker.windowPickEntries(entries, 'anthropic', null), entries)
})

test('text windows render the balance prefix in the active locale', () => {
  const { textWinLoc } = evalFns(fn('textWinLoc'), ['textWinLoc'])
  assert.equal(textWinLoc('余额 $38.91', 'en'), 'Balance $38.91')
  assert.equal(textWinLoc('余额 $38.91', 'zh'), '余额 $38.91')
  assert.equal(textWinLoc('余额$1', 'en'), 'Balance $1', 'no-space prefix still localizes')
  assert.equal(textWinLoc('余额  $1', 'en'), 'Balance $1', 'extra spacing collapses to one space')
  assert.equal(textWinLoc('Balance $1', 'en'), 'Balance $1', 'already English is idempotent')
  assert.equal(textWinLoc('余额', 'en'), 'Balance ', 'prefix-only value keeps the string contract')
  assert.equal(textWinLoc(undefined, 'en'), undefined)
  const object = { text: '余额 1' }
  assert.equal(textWinLoc(object, 'en'), object, 'non-strings pass through untouched')
})

test('both dictionaries carry the picker messages (zh/en parity)', () => {
  // The build packs the dictionaries positionally, so a key must exist in BOTH locales or one
  // language renders the literal key fallback.
  const { MESSAGES } = evalFns(`const MESSAGES = ${balanced(clientSource, clientSource.indexOf('const MESSAGES = {') + 'const MESSAGES ='.length)}`, ['MESSAGES'])
  for (const key of ['cmPickLabel', 'cmPickNote', 'cmPickToggleHint']) {
    assert.equal(typeof MESSAGES.zh[key], 'string', `MESSAGES.zh.${key}`)
    assert.equal(typeof MESSAGES.en[key], 'string', `MESSAGES.en.${key}`)
    assert.ok(MESSAGES.zh[key].length > 0 && MESSAGES.en[key].length > 0)
  }
})

test('the plan settings picker helpers stay wired to the real components', () => {
  // Supplementary source wiring (behavior is proved by the render suite): the fragment must call
  // the picker helpers from the components that render windows, not define them unused.
  for (const symbol of ['windowPickKey', 'windowPickOf', 'windowPickSet', 'windowPickEntries', 'textWinLoc']) {
    const uses = clientSource.split(symbol).length - 1
    const declares = clientSource.split(`function ${symbol}(`).length - 1 + clientSource.split(`const ${symbol} =`).length - 1
    assert.ok(declares >= 1, `${symbol} is declared in the fragments`)
    assert.ok(uses > declares, `${symbol} is referenced by render paths (${uses} occurrences)`)
  }
})

// TEST-ONLY: Task 8 — usage pace/verdict helpers and their card wiring.
test('pace helpers compute the rate and the over/under verdict against an injected clock', () => {
  const { paceOf, paceStatusOf } = evalFns(['paceOf', 'paceStatusOf'].map(fn).join('\n'), ['paceOf', 'paceStatusOf'])
  const now = Date.parse('2026-10-01T00:00:00Z')
  const end = now + 7 * 864e5
  assert.equal(paceOf(40, new Date(end).toISOString(), now), 'Pace 8.6%/day')
  assert.equal(paceOf(40, '', now), null)
  assert.deepEqual(paceStatusOf(50, now - 3.5 * 864e5, now + 3.5 * 864e5, now), { t: 'On pace', lvl: 'ok' })
  assert.deepEqual(paceStatusOf(60, now - 3.5 * 864e5, now + 3.5 * 864e5, now), { t: 'Over pace by 10.0%', lvl: 'over' })
  assert.deepEqual(paceStatusOf(40, now - 3.5 * 864e5, now + 3.5 * 864e5, now), { t: 'Under pace by 10.0%', lvl: 'ok' })
  assert.equal(paceStatusOf(40, undefined, now + 3.5 * 864e5, now), null)
})

test('verdicts and picker wiring survive in the readable client source', () => {
  // Wiring assertions in the upstream `readClientSource()` idiom (verify.mjs): pure-helper tests
  // above cover the math; these pin the connections a pure test cannot observe.
  assert.match(clientSource, /windowPickEntries\(Object\.entries\(windows\),\s*rowDef\.id\)/, 'strip honours the picker')
  assert.match(clientSource, /windowPickOf\(rowDef\.id\)\s*===\s*null\s*&&\s*shown\s*>=\s*2/, 'strip cap bypassed only by an explicit pick')
  assert.match(clientSource, /id\s*===\s*'commandcode'\s*\?\s*Object\.entries\(windows\)\s*:\s*windowPickEntries/, 'CC card bypasses the picker')
  assert.ok(clientSource.includes('cm-verdict'), 'verdict span present')
  assert.ok(clientSource.includes('periodStartAt'), 'CC pace status reads the API period start')
  assert.ok(!clientSource.includes('ccMoResetISO'), 'no guessed CC reset fallback remains')
  const footer = fn('SidebarFooter')
  assert.ok(footer.includes('CodexPlanBox') && footer.includes('sidebarPlanIds.map'), 'Codex card and plan rows both present')
  assert.ok(footer.indexOf('CodexPlanBox') < footer.indexOf('sidebarPlanIds.map'), 'Codex card stacks first')
  const css = readFileSync(join(root, 'src/client', '01-open-styles-i18n.js'), 'utf8')
  for (const rule of [
    '.cm-footer-stack .cm-bbox:not(.cm-bbox-pair){padding:6px 10px',
    '.cm-verdict{font-weight:600}',
    '.cm-verdict.warn{color:var(--dsw-alias-state-warn-primary)}',
    '.cm-footer-stack .cm-bbox-head>.cm-bbox-label{font-size:12px',
    '.cm-footer-stack .cm-bbox-head>.cm-bbox-pct{font-size:15px',
    '.cm-footer-stack:not(.simple) .cm-bbox:not(.cm-bbox-pair)>.cm-bbox-bar{height:5px}',
    '.cm-footer-stack .cm-bbox-line{font-size:11px}',
    '.cm-pick-row{',
  ]) assert.ok(css.includes(rule), `CSS rule present: ${rule}`)
})

// TEST-ONLY: Task 9 — plan-equivalent estimate, client classifier mirror and cost labels.
test('the plan-equivalent estimate is today cost minus recorded API spend and never negative', () => {
  const { planEquivalentEstimate } = evalFns([fn('moneyCostOf'), fn('planEquivalentEstimate')].join('\n'), ['planEquivalentEstimate'])
  assert.equal(planEquivalentEstimate({ cost: 15, apiCost: 0 }), 15, 'a pure plan day keeps the whole equivalent amount')
  assert.equal(planEquivalentEstimate({ cost: 15, apiCost: 3 }), 12, 'real API spend is excluded from the estimate')
  assert.equal(planEquivalentEstimate({ cost: 3, apiCost: 3 }), 0, 'all-API usage has no plan equivalent')
  assert.equal(planEquivalentEstimate({ cost: 3 }), 0, 'legacy entry without apiCost counts as full API spend')
  // moneyCostOf's documented fallbacks, from the estimate's side: a garbled/negative/oversized
  // apiCost is never trusted into a negative estimate (it either clamps to cost or is dropped).
  assert.equal(planEquivalentEstimate({ cost: 15, apiCost: 20 }), 0, 'apiCost above cost clamps to full API spend')
  assert.equal(planEquivalentEstimate({ cost: 15, apiCost: -5 }), 0, 'negative apiCost is not cash spend: full cost')
  assert.equal(planEquivalentEstimate({ cost: 15, apiCost: 'garbled' }), 0, 'unparseable apiCost falls back to full cost')
  assert.equal(planEquivalentEstimate({ cost: 0, apiCost: 0 }), 0)
  assert.equal(planEquivalentEstimate(undefined), 0, 'missing bucket has no estimate')
  assert.equal(planEquivalentEstimate(null), 0, 'null bucket has no estimate')
})

test('the client plan classifier mirrors the host map and the usage consumer', () => {
  const slice = clientSource.slice(
    clientSource.indexOf('const PLAN_PROVIDER_ALIASES_LOCAL = {'),
    clientSource.indexOf('function usageSplit('),
  )
  assert.ok(slice.length > 0, 'client classifier block present')
  const { planProviderIdOfLocal, billingClassOfLocal, usageHasPlanClass } = evalFns(
    [fn('modelNameText'), fn('canonModelIdLocal'), slice, fn('usageHasPlanClass')].join('\n'),
    ['planProviderIdOfLocal', 'billingClassOfLocal', 'usageHasPlanClass'],
  )
  // The config the browser actually receives is sanitized: sanitizeConfig backfills every plan id
  // from DEFAULT_PLAN_PROVIDER_CLASS, including 'openai-codex' → 'plan' (real host path), so a config
  // that never listed the entry still classifies as plan.
  const sanitized = sanitizeConfig(defaultConfig())
  assert.equal(sanitized.planBilling.providers['openai-codex'], 'plan', 'host sanitizer backfills the Codex plan class')
  assert.equal(billingClassOfLocal('openai-codex', 'gpt-6-luna', sanitized), 'plan')
  assert.equal(billingClassOfLocal('llm-openai-codex', 'gpt-6-luna', sanitized), 'plan', 'the llm- wrapper route resolves to the same plan id')
  const apiConfig = structuredClone(sanitized)
  apiConfig.planBilling.providers['openai-codex'] = 'api'
  assert.equal(billingClassOfLocal('openai-codex', 'gpt-6-luna', apiConfig), 'api', 'an explicit API class wins over the default')
  // Route aliases inherit their enabled plan classification (providers stay 'auto'; the enabled set
  // supplies 'plan') — mirrors Task 5's host map, including the llm- wrapper spelling.
  const enabled = structuredClone(sanitized)
  enabled.codingPlans.commandcode.enabled = true
  enabled.goQuota.enabled = true
  for (const [provider, planId] of [
    ['command-code', 'commandcode'],
    ['llm-command-code', 'commandcode'],
    ['opencode-go-responses', 'go'],
    ['opencode-go-messages', 'go'],
  ]) {
    assert.equal(planProviderIdOfLocal(provider), planId, `${provider} maps to ${planId}`)
    assert.equal(billingClassOfLocal(provider, 'mimo-v2.6-flash', enabled), 'plan', `${provider} inherits the enabled plan class`)
  }
  assert.equal(billingClassOfLocal('opencode-go-responses', 'muse-spark-1.3-contributor', enabled), 'plan')
  assert.equal(billingClassOfLocal('opencode-go-messages', 'minimax-m2.7', enabled), 'plan')
  // Negative control: the explicit pay-as-you-go OpenCode Zen route is not a Go alias (host parity).
  assert.equal(planProviderIdOfLocal('opencode-zen'), null)
  assert.equal(billingClassOfLocal('opencode-zen', 'muse-spark-1.3-contributor', enabled), 'api')
  // Priority: a per-model override outranks the provider class, as on the host.
  const overridden = structuredClone(sanitized)
  overridden.planBilling.models['openai-codex:gpt-6-luna'] = 'api'
  assert.equal(billingClassOfLocal('openai-codex', 'gpt-6-luna', overridden), 'api', 'model-level override wins')
  // Documented missing-entry fallback: with the explicit entry deleted from an otherwise sanitized
  // config the mirror follows the enabled set → 'api' for codex. The host sanitizer is what backfills
  // 'plan'; the client adds no second default map.
  const entryless = structuredClone(sanitized)
  delete entryless.planBilling.providers['openai-codex']
  assert.equal(billingClassOfLocal('openai-codex', 'gpt-6-luna', entryless), 'api')
  // Session/subagent usage path (the consumer the classifier exists for), through the real helper.
  assert.equal(usageHasPlanClass({ byProviderModel: { 'openai-codex:gpt-6-luna': { cost: 1 } } }, sanitized), true)
  assert.equal(usageHasPlanClass({ byProviderModel: { 'openai-codex:gpt-6-luna': { cost: 1 } } }, apiConfig), false)
  assert.equal(usageHasPlanClass({ byProviderModel: { 'opencode-go-responses:muse-spark-1.3-contributor': { cost: 1 } } }, enabled), true)
  assert.equal(usageHasPlanClass({ byProviderModel: { 'opencode-zen:muse-spark-1.3-contributor': { cost: 1 } } }, enabled), false)
})

test('the plan-equivalent labels ship verbatim in both locales and the estimate is wired into the footer', () => {
  const i18n = readFileSync(join(root, 'src/client', '01-open-styles-i18n.js'), 'utf8')
  for (const key of ['planEquivalentEstimate', 'planEquivalentShort', 'todayEquivalent']) {
    const count = i18n.split(key + ':').length - 1
    assert.equal(count, 2, `${key} present in zh and en dictionaries`)
  }
  const { MESSAGES } = evalFns(`const MESSAGES = ${balanced(clientSource, clientSource.indexOf('const MESSAGES = {') + 'const MESSAGES ='.length)}`, ['MESSAGES'])
  const expected = {
    zh: {
      todayCostTitle: '今日 API 计价估算(订阅调用另列等值估算)',
      planEquivalentEstimate: 'Plan 调用的 API 等值估算 {amount}',
      planEquivalentShort: 'Plan 估算 {amount}',
      todayEquivalent: '今日 API 等值',
    },
    en: {
      todayCostTitle: "Today's API cost estimate (plan-equivalent shown separately)",
      planEquivalentEstimate: 'Plan-equivalent API estimate {amount}',
      planEquivalentShort: 'Plan est. {amount}',
      todayEquivalent: 'Today equivalent',
    },
  }
  for (const locale of ['zh', 'en']) for (const [key, value] of Object.entries(expected[locale])) {
    assert.equal(MESSAGES[locale][key], value, `MESSAGES.${locale}.${key} carries the canonical label`)
  }
  // Wiring: the estimate is computed from today's bucket, the tooltip lists the API-equivalent
  // amount, and the wide footer label switches with the plan-total toggle while the separate
  // estimate only renders when that toggle is off.
  assert.match(clientSource, /const cmPlanEq = planEquivalentEstimate\(today\)/, 'estimate computed from today')
  assert.match(clientSource, /className: 'cm-plan-estimate'/, 'footer renders the estimate span')
  assert.match(clientSource, /\.\.\.\(cmPlanEq > 0 \? \[t\('planEquivalentEstimate'/, 'tooltip lists the plan-equivalent estimate')
  assert.match(clientSource, /t\(config\.showTotalWithPlan === true \? 'todayEquivalent' : 'today'\)/, 'wide label switches with showTotalWithPlan')
  assert.match(clientSource, /config\.showTotalWithPlan !== true && cmPlanEq > 0/, 'separate estimate only while the toggle is off')
})
