// TEST-ONLY (never shipped: the `files` allowlist excludes test/).
// Fork behavior pins for the Codex plan/API separation:
//   - the default classification of the `openai-codex` route (and its `llm-` host wrapper);
//   - `repairLedgerPricing`'s exact/standardTier options used by the one-time Codex migration;
//   - the Codex-alias branch of the OpenRouter repair, including the owner-approved I2/I3
//     corrections: explicitly API-billed aliases keep their recorded long-context amount, and both
//     alias spellings must resolve the same effective override key the runtime resolver uses;
//   - the `openai-codex-plan-reprice-v1` wrapper itself, sliced out of lib/index.js and executed
//     against real fs + the real repricer (backup-before-write, run-once, backup preservation).
// Everything runs on synthetic fixtures: a throwaway HOME/DSH_HOME/XDG layout, a fail-closed fetch
// guard and temp ledger files. No profile, credential, session or network surface is touched.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { failClosedFetch, syntheticEnv } from './helpers/synthetic-env.mjs'

// Isolation first — before any lib/* import: synthetic HOME/DSH_HOME/XDG dirs and a fail-closed
// fetch guard, so no test can reach the real profile, credentials, sessions, or the network.
syntheticEnv()
const restoreFetch = failClosedFetch()
process.once('exit', restoreFetch)

const root = fileURLToPath(new URL('..', import.meta.url))
const lib = file => import(pathToFileURL(join(root, 'lib', file)).href)

const { billingClassOf, DEFAULT_PLAN_PROVIDER_CLASS, enabledPlanSetOf, planProviderIdOf } = await lib('plan-billing.js')
const { costOf, normalizePrice, providerPriceEntryFor } = await lib('pricing.js')
const { defaultConfig, repairLedgerPricing, sanitizeConfig, splitLedgerApiCost } = await lib('store.js')
const { createOpenRouterPriceRefresh, repairOpenRouterLedger } = await lib('openrouter-pricing.js')

const model = 'openai/gpt-6-luna'
const providerKey = 'openai-codex:gpt-6-luna'
const priceOverride = 'openrouter:openai/gpt-6-luna'
const price = {
  cacheHit: 0.01, cacheMiss: 0.1, output: 0.5, cacheWrite: 0.125,
  longContext: { aboveInputTokens: 272_000, cacheHit: 0.02, cacheMiss: 0.2, output: 1 },
  billingMode: 'flat',
  sourceUrl: 'https://openrouter.ai/api/v1/models',
  checkedAt: '2026-09-24',
}
const codexTokens = { input: 1_403_164, output: 153_439, cacheRead: 20_654_592, cacheWrite: 0, reasoning: 0, calls: 238 }

/** Hand-derived Codex fixture shared by the repricing cases and the migration-wrapper test. */
const codexLedgerFixture = () => ({
  config: {
    currency: 'USD', exchangeRate: 1, priceMatch: 'auto', priceOverrides: { [providerKey]: priceOverride },
    prices: { currency: 'USD', models: {}, default: {}, providers: { openrouter: { models: { [model]: price } } } },
    planBilling: { providers: { ...DEFAULT_PLAN_PROVIDER_CLASS }, models: {} },
    codingPlans: {}, goQuota: { enabled: false }, peakEnabled: false,
    peakEffectiveAt: '2026-08-01T00:00:00Z', peakWindows: [],
  },
  days: {
    '2026-09-25': {
      cost: 15.09817956, apiCost: 15.09817956,
      byProviderModel: { [providerKey]: { ...codexTokens, cost: 15.09817956, apiCost: 15.09817956 } },
      sessions: [],
    },
  },
})

const rateFingerprint = raw => {
  const { sourceUrl, checkedAt, notes, ...rates } = normalizePrice(raw)
  return createHash('sha256').update(JSON.stringify(rates)).digest('hex')
}

test('OpenAI Codex plan usage is plan-classified by default but can be explicitly API-billed', () => {
  const providers = { ...DEFAULT_PLAN_PROVIDER_CLASS }
  assert.equal(providers['openai-codex'], 'plan')
  const sanitized = sanitizeConfig(defaultConfig())
  assert.equal(sanitized.planBilling.providers['openai-codex'], 'plan')
  assert.equal(billingClassOf('openai-codex', 'gpt-6-luna', sanitized.planBilling, new Set()), 'plan')
  assert.equal(billingClassOf('openai-codex', 'gpt-6-luna', { providers, models: {} }, new Set()), 'plan')
  // The host wrapper route (`llm-` prefix, pricing.js stripping) is the same provider.
  assert.equal(planProviderIdOf('openai-codex'), 'openai-codex')
  assert.equal(planProviderIdOf('llm-openai-codex'), 'openai-codex')
  assert.equal(billingClassOf('llm-openai-codex', 'gpt-6-luna', { providers, models: {} }, new Set()), 'plan')
  providers['openai-codex'] = 'api'
  assert.equal(billingClassOf('openai-codex', 'gpt-6-luna', { providers, models: {} }, new Set()), 'api')
})

test('Command Code MiMo V2.6 Flash resolves its published token rates', () => {
  const config = defaultConfig()
  const resolved = providerPriceEntryFor('command-code', 'xiaomi/mimo-v2.6-flash', config.prices, {
    mode: 'auto', overrides: config.priceOverrides,
  })
  assert.equal(resolved.priced, true)
  assert.deepEqual([resolved.entry.cacheMiss, resolved.entry.cacheHit, resolved.entry.output], [0.14, 0.0028, 0.28])
})

test('legacy Codex aggregate migration forces standard-tier repricing', () => {
  const ledger = codexLedgerFixture()
  const acceptsCodex = key => key === providerKey
  const conservative = structuredClone(ledger)
  assert.equal(repairLedgerPricing(conservative, acceptsCodex).recostedBuckets, 0)
  const result = repairLedgerPricing(ledger, acceptsCodex, { exact: true, standardTier: true })
  const repaired = ledger.days['2026-09-25'].byProviderModel[providerKey]
  assert.equal(result.recostedBuckets, 1)
  assert.ok(Math.abs(repaired.cost - 0.42358182) < 1e-9)
  assert.equal(repaired.apiCost, 0)
  assert.ok(Math.abs(ledger.days['2026-09-25'].cost - 0.42358182) < 1e-9)
  assert.equal(ledger.days['2026-09-25'].apiCost, 0)
})

test('session-level Codex aggregates are repaired under the same exact/standard-tier policy', () => {
  const ledger = codexLedgerFixture()
  const day = ledger.days['2026-09-25']
  const session = {
    at: Date.parse('2026-09-25T09:00:00Z'), cost: day.cost, apiCost: day.apiCost,
    byProviderModel: { [providerKey]: { ...codexTokens, cost: day.cost, apiCost: day.apiCost } },
  }
  day.sessions = [session]
  const result = repairLedgerPricing(ledger, key => key === providerKey, { exact: true, standardTier: true })
  assert.equal(result.recostedBuckets, 2, 'daily and session buckets are both repriced')
  assert.equal(result.touchedSessions, 1)
  const bucket = session.byProviderModel[providerKey]
  assert.ok(Math.abs(bucket.cost - 0.42358182) < 1e-9)
  assert.equal(bucket.apiCost, 0)
  assert.ok(Math.abs(session.cost - 0.42358182) < 1e-9)
  assert.equal(session.apiCost, 0)
})

test('managed OpenAI Codex aliases are repriced after the one-time OpenRouter migration', () => {
  const bucket = { ...codexTokens, cost: 0.4235, apiCost: 0.4235 }
  const ledger = {
    migrations: ['pricing-openrouter-v1'],
    openrouterPriceHashes: { [model]: rateFingerprint(price) },
    config: {
      currency: 'USD', exchangeRate: 1, priceMatch: 'auto', priceOverrides: { [providerKey]: priceOverride },
      prices: { currency: 'USD', models: {}, default: {}, providers: { openrouter: { models: { [model]: price } } } },
      planBilling: { providers: { ...DEFAULT_PLAN_PROVIDER_CLASS }, models: {} },
      codingPlans: {}, goQuota: { enabled: false }, peakEnabled: false,
      peakEffectiveAt: '2026-08-01T00:00:00Z', peakWindows: [],
    },
    days: { '2026-09-25': { cost: bucket.cost, apiCost: bucket.apiCost, byProviderModel: { [providerKey]: bucket }, sessions: [] } },
  }
  const result = repairOpenRouterLedger(ledger)
  const repaired = ledger.days['2026-09-25'].byProviderModel[providerKey]
  assert.equal(result.recostedBuckets, 1)
  assert.ok(Math.abs(repaired.cost - 0.42358182) < 1e-9)
  assert.equal(repaired.apiCost, 0)
})

test('Codex migration wrapper backs up before persisting and stays idempotent on disk', async () => {
  const { repairLedgerPricing, splitLedgerApiCost } = await lib('store.js')   // REAL functions, no stubs
  const block = migrationBlock(readFileSync(join(root, 'lib', 'index.js'), 'utf8'), 'openai-codex-plan-reprice-v1')
  assert.match(block, /repairLedgerPricing\(ledger, isCodex, \{ exact: true, standardTier: true \}\)/)
  assert.match(block, /\.pre-openai-codex-plan-reprice-v1/)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-migration-a-'))
  const path = join(dir, 'ledger.json')
  const backupPath = path + '.pre-openai-codex-plan-reprice-v1'
  const ledger = codexLedgerFixture()
  const original = JSON.stringify(ledger)
  writeFileSync(path, original)

  // (a) Ordering is causal: the scheduled write may only run AFTER the backup exists and holds the
  // pre-migration bytes; the callback then actually persists the migrated ledger to the real file.
  ledger.path = path
  ledger.migrations = []
  let writes = 0
  ledger.scheduleWrite = () => {
    assert.ok(fs.existsSync(backupPath), 'backup must exist before any write')
    assert.equal(readFileSync(backupPath, 'utf8'), original, 'backup must hold the pre-migration bytes')
    writes += 1
    writeFileSync(path, JSON.stringify(ledger))
  }
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.deepEqual(ledger.migrations, ['openai-codex-plan-reprice-v1'])
  assert.equal(ledger.config.planBilling.providers['openai-codex'], 'plan')
  assert.equal(writes, 1, 'exactly one scheduled write')
  const persisted = readFileSync(path, 'utf8')
  assert.notEqual(persisted, original, 'the ledger file actually changed on disk')
  assert.match(persisted, /"openai-codex-plan-reprice-v1"/, 'persisted state records the migration')
  const bucket = ledger.days['2026-09-25'].byProviderModel[providerKey]
  assert.ok(Math.abs(bucket.cost - 0.42358182) < 1e-9, 'the real repricer ran with exact+standardTier')
  assert.equal(bucket.apiCost, 0)

  // (b) Already-migrated persisted state: nothing is touched again.
  const afterFirst = readFileSync(path, 'utf8')
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.equal(readFileSync(path, 'utf8'), afterFirst, 'disk unchanged on the second run')
  assert.equal(readFileSync(backupPath, 'utf8'), original, 'backup unchanged on the second run')
  assert.equal(writes, 1, 'no second scheduled write')

  // (c) A pre-existing backup is preserved, never overwritten.
  const sentinel = '{"pre-existing":true}'
  writeFileSync(backupPath, sentinel)
  ledger.migrations = []
  ledger.scheduleWrite = () => {}
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.equal(readFileSync(backupPath, 'utf8'), sentinel, 'existing backup preserved')
  rmSync(dir, { recursive: true, force: true })
})

// ── Owner-approved I2/I3 corrections (2026-10-17) ──
//
// I2: explicitly API-billed Codex aliases must keep their recorded (real) long-context amount; the
//     standard-tier approximation only serves plan estimates. I3: the alias refresh must resolve the
//     same effective override key the runtime price resolver uses (`llm-` stripped), so wrapped and
//     unwrapped routes behave identically and an inactive raw-wrapper-only entry triggers nothing.

const AT_MS = Date.parse('2026-09-25T12:00:00Z')
const wrapperKey = 'llm-openai-codex:gpt-6-luna'
const apiKey = 'openai-codex:gpt-6-luna-api'
const apiModel = 'openai/gpt-6-luna-api'
const apiOverride = 'openrouter:' + apiModel
/** One 3M-input-token call: $0.60 at the fixture's long-context rate, $0.30 at the standard rate. */
const longTokens = { input: 3_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 }
const LONG_CONTEXT_COST = 0.6
const STANDARD_TIER_COST = 0.3
const API_PROVIDER_CLASS = { providers: { ...DEFAULT_PLAN_PROVIDER_CLASS, 'openai-codex': 'api' } }

const managedPrices = (ids, modelPrice = price) => ({
  currency: 'USD', models: {}, default: {},
  providers: { openrouter: { models: Object.fromEntries(ids.map(id => [id, { ...modelPrice }])) } },
})
const managedHashes = (ids, modelPrice = price) => Object.fromEntries(ids.map(id => [id, rateFingerprint(modelPrice)]))

/**
 * Managed alias ledger: every `keys` route records the same long-context aggregate in its daily and
 * in one session bucket. `planBilling` selects the billing class; `overrides` map the routes to the
 * managed OpenRouter catalog entries.
 */
function managedAliasLedger({
  keys, models, overrides, planBilling = {}, cost = LONG_CONTEXT_COST, tokens = longTokens,
  modelPrice = price, migrations = ['pricing-openrouter-v1'],
}) {
  const bucket = () => ({ ...tokens, cost, apiCost: cost })
  const buckets = () => Object.fromEntries(keys.map(key => [key, bucket()]))
  const total = cost * keys.length
  return {
    migrations: [...migrations],
    openrouterPriceHashes: managedHashes(models, modelPrice),
    config: {
      currency: 'USD', exchangeRate: 1, priceMatch: 'auto', priceOverrides: { ...overrides },
      prices: managedPrices(models, modelPrice),
      planBilling: { providers: { ...DEFAULT_PLAN_PROVIDER_CLASS }, models: {}, ...planBilling },
      codingPlans: {}, goQuota: { enabled: false }, peakEnabled: false,
      peakEffectiveAt: '2026-08-01T00:00:00Z', peakWindows: [],
    },
    days: {
      '2026-09-25': {
        cost: total, apiCost: total, byProviderModel: buckets(),
        sessions: [{ at: AT_MS, cost: total, apiCost: total, byProviderModel: buckets() }],
      },
    },
  }
}
const dayBucketsOf = ledger => ledger.days['2026-09-25'].byProviderModel
const sessionBucketsOf = ledger => ledger.days['2026-09-25'].sessions[0].byProviderModel
const runtimeEntryOf = (ledger, modelId) => providerPriceEntryFor('llm-openai-codex', modelId, ledger.config.prices, {
  mode: 'auto', overrides: ledger.config.priceOverrides,
})

test('a 300,000-token API long-context record of $0.60 never becomes the $0.30 standard amount', () => {
  // The receipt shape from the branch review: 300k input tokens, real long-tier $0.60, standard $0.30.
  const reviewPrice = {
    cacheHit: 0.01, cacheMiss: 1, output: 5, cacheWrite: 0.125,
    longContext: { aboveInputTokens: 272_000, cacheHit: 0.02, cacheMiss: 2, output: 10 },
    billingMode: 'flat', sourceUrl: 'https://openrouter.ai/api/v1/models', checkedAt: '2026-09-24',
  }
  const tokens = { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 }
  const variants = [
    ['provider-level API override', API_PROVIDER_CLASS],
    ['model-level API override', { models: { [providerKey]: 'api' } }],
  ]
  for (const [label, planBilling] of variants) {
    const ledger = managedAliasLedger({
      keys: [providerKey, wrapperKey], models: [model], overrides: { [providerKey]: priceOverride },
      planBilling, tokens, modelPrice: reviewPrice,
    })
    const runtime = runtimeEntryOf(ledger, 'gpt-6-luna')
    assert.equal(costOf(tokens, runtime.entry, AT_MS, { enabled: false }), LONG_CONTEXT_COST, `${label}: the real long-context amount`)
    assert.equal(costOf(tokens, { ...runtime.entry, longContext: undefined }, AT_MS, { enabled: false }), STANDARD_TIER_COST, `${label}: the real standard amount`)
    const result = repairOpenRouterLedger(ledger)
    for (const buckets of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
      for (const key of [providerKey, wrapperKey]) {
        assert.equal(buckets[key].cost, LONG_CONTEXT_COST, `${label}: ${key} keeps $0.60`)
        assert.equal(buckets[key].apiCost, LONG_CONTEXT_COST, `${label}: ${key} keeps its $0.60 API spend`)
      }
    }
    assert.equal(result.recostedBuckets, 0, `${label}: the record is not rewritten`)
    const day = ledger.days['2026-09-25']
    assert.equal(day.cost, LONG_CONTEXT_COST * 2)
    assert.equal(day.apiCost, LONG_CONTEXT_COST * 2)
    assert.equal(day.sessions[0].cost, LONG_CONTEXT_COST * 2)
    assert.equal(day.sessions[0].apiCost, LONG_CONTEXT_COST * 2)
  }
})

test('provider-level API billing keeps the recorded long-context amount through the alias refresh', () => {
  const ledger = managedAliasLedger({
    keys: [providerKey, wrapperKey], models: [model],
    overrides: { [providerKey]: priceOverride }, planBilling: API_PROVIDER_CLASS,
  })
  // The $0.60 record is the real long-context price of these tokens, proven by the real resolver.
  const runtime = runtimeEntryOf(ledger, 'gpt-6-luna')
  assert.equal(costOf(longTokens, runtime.entry, AT_MS, { enabled: false }), LONG_CONTEXT_COST)
  const result = repairOpenRouterLedger(ledger)
  assert.equal(result.recostedBuckets, 0, 'an API-billed alias is not approximated')
  assert.equal(result.touchedDays, 0)
  assert.equal(result.touchedSessions, 0)
  for (const buckets of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
    for (const key of [providerKey, wrapperKey]) {
      assert.equal(buckets[key].cost, LONG_CONTEXT_COST, `${key} keeps its recorded API cost`)
      assert.equal(buckets[key].apiCost, LONG_CONTEXT_COST, `${key} keeps its real API spend`)
    }
  }
  const day = ledger.days['2026-09-25']
  assert.equal(day.cost, LONG_CONTEXT_COST * 2)
  assert.equal(day.apiCost, LONG_CONTEXT_COST * 2)
  assert.equal(day.sessions[0].cost, LONG_CONTEXT_COST * 2)
  assert.equal(day.sessions[0].apiCost, LONG_CONTEXT_COST * 2)
})

test('model-level API billing keeps the recorded long-context amount through the alias refresh', () => {
  // The canonical `openai-codex:` key also classifies the `llm-` wrapper route at runtime.
  const planBilling = { models: { [providerKey]: 'api' } }
  const ledger = managedAliasLedger({
    keys: [providerKey, wrapperKey], models: [model], overrides: { [providerKey]: priceOverride }, planBilling,
  })
  const enabled = new Set()
  assert.equal(billingClassOf(providerKey.slice(0, providerKey.indexOf(':')), 'gpt-6-luna', ledger.config.planBilling, enabled), 'api')
  assert.equal(billingClassOf('llm-openai-codex', 'gpt-6-luna', ledger.config.planBilling, enabled), 'api')
  const result = repairOpenRouterLedger(ledger)
  assert.equal(result.recostedBuckets, 0, 'an API-billed alias is not approximated')
  for (const buckets of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
    for (const key of [providerKey, wrapperKey]) {
      assert.equal(buckets[key].cost, LONG_CONTEXT_COST, `${key} keeps its recorded API cost`)
      assert.equal(buckets[key].apiCost, LONG_CONTEXT_COST)
      assert.notEqual(buckets[key].cost, STANDARD_TIER_COST, 'the standard-tier amount never replaces it')
    }
  }
  assert.equal(ledger.days['2026-09-25'].cost, LONG_CONTEXT_COST * 2)
  assert.equal(ledger.days['2026-09-25'].apiCost, LONG_CONTEXT_COST * 2)
})

test('the alias refresh still approximates plan estimates while leaving explicit API spend alone', () => {
  const ledger = managedAliasLedger({
    keys: [providerKey, apiKey], models: [model, apiModel],
    overrides: { [providerKey]: priceOverride, [apiKey]: apiOverride },
    planBilling: { models: { [apiKey]: 'api' } },
  })
  const result = repairOpenRouterLedger(ledger)
  assert.equal(result.recostedBuckets, 2, 'only the daily and session plan-estimate buckets are repriced')
  assert.equal(result.touchedDays, 1)
  assert.equal(result.touchedSessions, 1)
  for (const buckets of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
    assert.ok(Math.abs(buckets[providerKey].cost - STANDARD_TIER_COST) < 1e-9, 'the plan estimate still reprices at the standard tier')
    assert.equal(buckets[providerKey].apiCost, 0, 'a plan estimate is not cash spend')
    assert.equal(buckets[apiKey].cost, LONG_CONTEXT_COST, 'API-billed long-context spend is not approximated')
    assert.equal(buckets[apiKey].apiCost, LONG_CONTEXT_COST)
  }
  const day = ledger.days['2026-09-25']
  assert.ok(Math.abs(day.cost - (STANDARD_TIER_COST + LONG_CONTEXT_COST)) < 1e-9)
  assert.ok(Math.abs(day.apiCost - LONG_CONTEXT_COST) < 1e-9)
  assert.ok(Math.abs(day.sessions[0].cost - (STANDARD_TIER_COST + LONG_CONTEXT_COST)) < 1e-9)
  assert.ok(Math.abs(day.sessions[0].apiCost - LONG_CONTEXT_COST) < 1e-9)
})

test('the one-time Codex migration keeps explicit API spend while repricing plan estimates', async () => {
  const { repairLedgerPricing, splitLedgerApiCost } = await lib('store.js')   // REAL functions, no stubs
  const block = migrationBlock(readFileSync(join(root, 'lib', 'index.js'), 'utf8'), 'openai-codex-plan-reprice-v1')
  // Per variant: expected [cost, apiCost] per bucket. A provider-level API class covers every Codex
  // model, so nothing is a plan estimate there; a model-level API class leaves the sibling estimate.
  const variants = [
    ['provider-level API override', API_PROVIDER_CLASS, {
      [providerKey]: [LONG_CONTEXT_COST, LONG_CONTEXT_COST], [apiKey]: [LONG_CONTEXT_COST, LONG_CONTEXT_COST],
    }],
    ['model-level API override', { models: { [apiKey]: 'api' } }, {
      [providerKey]: [STANDARD_TIER_COST, 0], [apiKey]: [LONG_CONTEXT_COST, LONG_CONTEXT_COST],
    }],
  ]
  for (const [label, planBilling, expected] of variants) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-migration-a-api-'))
    const path = join(dir, 'ledger.json')
    const backupPath = path + '.pre-openai-codex-plan-reprice-v1'
    const ledger = managedAliasLedger({
      keys: [apiKey, providerKey], models: [model, apiModel],
      overrides: { [providerKey]: priceOverride, [apiKey]: apiOverride }, planBilling, migrations: [],
    })
    const original = JSON.stringify(ledger)
    writeFileSync(path, original)
    ledger.path = path
    let writes = 0
    ledger.scheduleWrite = () => {
      assert.ok(fs.existsSync(backupPath), `${label}: backup must exist before any write`)
      assert.equal(readFileSync(backupPath, 'utf8'), original, `${label}: backup must hold the pre-migration bytes`)
      writes += 1
      writeFileSync(path, JSON.stringify(ledger))
    }
    runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
    const dayCost = Object.values(expected).reduce((sum, [cost]) => sum + cost, 0)
    const dayApi = Object.values(expected).reduce((sum, [, apiCost]) => sum + apiCost, 0)
    for (const buckets of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
      for (const [key, [cost, apiCost]] of Object.entries(expected)) {
        assert.equal(buckets[key].cost, cost, `${label}: ${key} cost`)
        assert.equal(buckets[key].apiCost, apiCost, `${label}: ${key} API spend`)
      }
      assert.notEqual(buckets[apiKey].cost, STANDARD_TIER_COST, `${label}: the API record never takes the standard amount`)
      assert.equal(buckets[apiKey].apiCost, buckets[apiKey].cost, `${label}: the API record stays cash spend`)
    }
    const day = ledger.days['2026-09-25']
    assert.equal(day.cost, dayCost, `${label}: the day total follows the buckets`)
    assert.equal(day.apiCost, dayApi, `${label}: the day keeps the API share`)
    assert.equal(day.sessions[0].cost, dayCost, `${label}: the session total follows the buckets`)
    assert.equal(day.sessions[0].apiCost, dayApi, `${label}: the session keeps the API share`)
    assert.deepEqual(ledger.migrations, ['openai-codex-plan-reprice-v1'])
    assert.equal(writes, 1, `${label}: exactly one scheduled write`)
    assert.match(readFileSync(path, 'utf8'), /"openai-codex-plan-reprice-v1"/)
    // Run-once: the marker stops the block from touching the persisted amounts again.
    runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
    assert.equal(writes, 1, `${label}: no second write`)
    assert.equal(dayBucketsOf(ledger)[apiKey].cost, LONG_CONTEXT_COST, `${label}: the API record is still untouched`)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wrapped and unwrapped Codex aliases resolve the same effective override as runtime pricing', () => {
  const ledger = managedAliasLedger({
    keys: [providerKey, wrapperKey], models: [model], overrides: { [providerKey]: priceOverride },
  })
  const runtime = runtimeEntryOf(ledger, 'gpt-6-luna')
  assert.equal(runtime.priced, true, 'runtime prices the wrapped route through the normalized override')
  assert.equal(runtime.entry.cacheMiss, price.cacheMiss)
  const result = repairOpenRouterLedger(ledger)
  assert.equal(result.recostedBuckets, 4, 'both spellings are refreshed in the day and in the session')
  for (const buckets of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
    for (const key of [providerKey, wrapperKey]) {
      assert.ok(Math.abs(buckets[key].cost - STANDARD_TIER_COST) < 1e-9, `${key} is repriced like its sibling`)
      assert.equal(buckets[key].apiCost, 0)
    }
  }
  const day = ledger.days['2026-09-25']
  assert.ok(Math.abs(day.cost - STANDARD_TIER_COST * 2) < 1e-9)
  assert.equal(day.apiCost, 0)
  assert.ok(Math.abs(day.sessions[0].cost - STANDARD_TIER_COST * 2) < 1e-9)
  assert.equal(day.sessions[0].apiCost, 0)
})

test('an inactive raw-wrapper-only override does not trigger the alias refresh', () => {
  const ledger = managedAliasLedger({
    keys: [wrapperKey, providerKey], models: [model], overrides: { [wrapperKey]: priceOverride },
  })
  // The route is priced by its own provider table, so only the inactive raw key could make the
  // refresh treat these buckets as managed OpenRouter aliases.
  ledger.config.prices.providers['openai-codex'] = { models: { 'gpt-6-luna': { ...price } } }
  assert.equal(runtimeEntryOf(ledger, 'gpt-6-luna').priced, true, 'runtime prices the route without the inactive raw key')
  const result = repairOpenRouterLedger(ledger)
  assert.equal(result.recostedBuckets, 0, 'an entry the runtime ignores must not trigger the refresh')
  for (const buckets of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
    for (const key of [wrapperKey, providerKey]) {
      assert.equal(buckets[key].cost, LONG_CONTEXT_COST, `${key} is left alone`)
      assert.equal(buckets[key].apiCost, LONG_CONTEXT_COST)
    }
  }
  assert.equal(ledger.days['2026-09-25'].cost, LONG_CONTEXT_COST * 2)
})

test('manual and unmanaged price targets stay excluded from the alias refresh', () => {
  // (a) The alias points at an OpenRouter entry the user edited by hand: not a managed target.
  const edited = managedAliasLedger({ keys: [providerKey], models: [model], overrides: { [providerKey]: priceOverride } })
  edited.config.prices.providers.openrouter.models[model] = { ...price, cacheMiss: 9 }
  assert.equal(repairOpenRouterLedger(edited).recostedBuckets, 0)
  assert.equal(dayBucketsOf(edited)[providerKey].cost, LONG_CONTEXT_COST)
  // (b) An API-billed alias whose target entry is absent from the catalog is left as recorded.
  const targetless = managedAliasLedger({
    keys: [apiKey], models: [apiModel], overrides: { [apiKey]: apiOverride }, planBilling: API_PROVIDER_CLASS,
  })
  targetless.config.prices.providers.openrouter.models = {}
  targetless.openrouterPriceHashes = {}
  assert.equal(repairOpenRouterLedger(targetless).recostedBuckets, 0)
  assert.equal(dayBucketsOf(targetless)[apiKey].cost, LONG_CONTEXT_COST)
  // (c) The zero-cost OpenRouter flat repair keeps its own manual-override guard.
  const mappedKey = 'openrouter:' + model
  const mapped = managedAliasLedger({
    keys: [mappedKey], models: [model], overrides: { [mappedKey]: mappedKey }, cost: 0, migrations: [],
  })
  assert.equal(repairOpenRouterLedger(mapped).recostedBuckets, 0)
  assert.equal(dayBucketsOf(mapped)[mappedKey].cost, 0)
})

test('the real OpenRouter price refresh keeps explicit API spend and still refreshes plan estimates', async () => {
  const { Ledger, defaultConfig, sanitizeConfig } = await lib('store.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-refresh-api-'))
  const ledger = new Ledger(sanitizeConfig(defaultConfig()), {}, join(dir, 'ledger.json'))
  try {
    // A ledger that already completed the one-time OpenRouter migration and holds one API-billed and
    // one plan-estimate Codex alias, both mapped to managed catalog entries.
    ledger.migrations = ['pricing-openrouter-v1']
    ledger.config.priceOverrides = { [providerKey]: priceOverride, [apiKey]: apiOverride }
    ledger.config.prices.providers.openrouter = { models: { [model]: { ...price }, [apiModel]: { ...price } } }
    ledger.config.planBilling.models[apiKey] = 'api'
    ledger.openrouterPriceHashes = managedHashes([model, apiModel])
    const buckets = { [providerKey]: { ...longTokens, cost: LONG_CONTEXT_COST, apiCost: LONG_CONTEXT_COST },
      [apiKey]: { ...longTokens, cost: LONG_CONTEXT_COST, apiCost: LONG_CONTEXT_COST } }
    ledger.days['2026-09-25'] = {
      cost: LONG_CONTEXT_COST * 2, apiCost: LONG_CONTEXT_COST * 2,
      byProviderModel: structuredClone(buckets),
      sessions: [{ at: AT_MS, cost: LONG_CONTEXT_COST * 2, apiCost: LONG_CONTEXT_COST * 2, byProviderModel: structuredClone(buckets) }],
    }
    const directoryRow = (id, prompt) => ({ id, pricing: { prompt, completion: '0.0000002' } })
    const controller = createOpenRouterPriceRefresh(ledger, {
      fetchImpl: async () => Response.json({ data: [directoryRow(model, '0.00000005'), directoryRow(apiModel, '0.00000005')] }),
    })
    try {
      const result = await controller.refresh()
      assert.equal(result.count, 2, 'both managed catalog entries are refreshed')
      assert.equal(ledger.config.prices.providers.openrouter.models[model].cacheMiss, 0.05, 'the directory entry landed')
      assert.ok(ledger.migrations.includes('pricing-openrouter-v1'), 'the migration marker is untouched')
      const planCost = 3_000_000 * 0.05 / 1_000_000
      for (const group of [dayBucketsOf(ledger), sessionBucketsOf(ledger)]) {
        assert.equal(group[providerKey].cost, planCost, 'the plan estimate follows the refreshed catalog')
        assert.equal(group[providerKey].apiCost, 0)
        assert.equal(group[apiKey].cost, LONG_CONTEXT_COST, 'the API record keeps its amount through the refresh')
        assert.equal(group[apiKey].apiCost, LONG_CONTEXT_COST)
      }
      const day = ledger.days['2026-09-25']
      assert.equal(day.cost, planCost + LONG_CONTEXT_COST)
      assert.equal(day.apiCost, LONG_CONTEXT_COST)
      assert.equal(day.sessions[0].cost, planCost + LONG_CONTEXT_COST)
      assert.equal(day.sessions[0].apiCost, LONG_CONTEXT_COST)
    } finally {
      controller.dispose()
    }
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Command Code and OpenCode Go routes inherit their enabled plan classifications', () => {
  const config = defaultConfig()
  config.codingPlans.commandcode.enabled = true
  config.goQuota.enabled = true
  const enabled = enabledPlanSetOf(config)
  for (const [provider, planId] of [
    ['command-code', 'commandcode'],
    ['llm-command-code', 'commandcode'],
    ['opencode-go-responses', 'go'],
    ['opencode-go-messages', 'go'],
  ]) {
    assert.equal(planProviderIdOf(provider), planId)
    assert.equal(billingClassOf(provider, 'muse-spark-1.3-contributor', config.planBilling, enabled, config.prices), 'plan')
  }
  config.planBilling.providers.commandcode = 'api'
  assert.equal(billingClassOf('command-code', 'muse-spark-1.3-contributor', config.planBilling, enabled, config.prices), 'api')
})

test('historical subscription repricing retains estimate and removes API spend', () => {
  const ledger = subscriptionLedgerFixture()
  const result = repairLedgerPricing(ledger, candidate => candidate === subKey, { exact: true })
  splitLedgerApiCost(ledger)
  const day = ledger.days['2026-09-25']
  assert.equal(result.recostedBuckets, 2)
  assert.ok(Math.abs(day.byProviderModel[subKey].cost - 1.2557265112) < 1e-9)
  assert.equal(day.byProviderModel[subKey].apiCost, 0)
  assert.equal(day.apiCost, 0)
  assert.ok(Math.abs(day.sessions[0].byProviderModel[subKey].cost - 1.2557265112) < 1e-9)
  assert.equal(day.sessions[0].byProviderModel[subKey].apiCost, 0)
})

// Shared hand-derived fixture for the Command Code / OpenCode Go subscription route.
const subKey = 'command-code:xiaomi/mimo-v2.6-flash'
const subTokens = { input: 4_380_147, output: 1_490_449, cacheRead: 80_421_504, cacheWrite: 0, reasoning: 0, calls: 14 }
const subscriptionLedgerFixture = () => {
  const config = defaultConfig()
  config.codingPlans.commandcode.enabled = true
  return {
    config,
    days: {
      '2026-09-25': {
        cost: 0, apiCost: 0,
        byProviderModel: { [subKey]: { ...subTokens, cost: 0, apiCost: 0 } },
        sessions: [{ at: Date.parse('2026-09-25T12:00:00Z'), cost: 0, apiCost: 0, byProviderModel: { [subKey]: { ...subTokens, cost: 0, apiCost: 0 } } }],
      },
    },
  }
}

test('subscription migration wrapper backs up first, reprices, and never re-runs', async () => {
  const { repairLedgerPricing, splitLedgerApiCost } = await lib('store.js')   // REAL functions, no stubs
  const block = migrationBlock(readFileSync(join(root, 'lib', 'index.js'), 'utf8'), 'subscription-provider-plan-reprice-v1')
  assert.match(block, /repairLedgerPricing\(ledger, isSubscriptionRoute, \{ exact: true \}\)/)
  assert.match(block, /\.pre-subscription-provider-plan-reprice-v1/)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-migration-b-'))
  const path = join(dir, 'ledger.json')
  const backupPath = path + '.pre-subscription-provider-plan-reprice-v1'
  const ledger = subscriptionLedgerFixture()
  const original = JSON.stringify(ledger)
  writeFileSync(path, original)
  ledger.path = path
  ledger.migrations = []
  let writes = 0
  ledger.scheduleWrite = () => {
    assert.ok(fs.existsSync(backupPath), 'backup must exist before any write')
    assert.equal(readFileSync(backupPath, 'utf8'), original, 'backup must hold the pre-migration bytes')
    writes += 1
    writeFileSync(path, JSON.stringify(ledger))
  }
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.deepEqual(ledger.migrations, ['subscription-provider-plan-reprice-v1'])
  assert.equal(writes, 1, 'exactly one scheduled write')
  const persisted = readFileSync(path, 'utf8')
  assert.notEqual(persisted, original, 'the ledger file actually changed on disk')
  assert.match(persisted, /"subscription-provider-plan-reprice-v1"/, 'persisted state records the migration')
  const day = ledger.days['2026-09-25']
  assert.ok(Math.abs(day.byProviderModel[subKey].cost - 1.2557265112) < 1e-9, 'the real repricer ran')
  assert.equal(day.byProviderModel[subKey].apiCost, 0)
  assert.equal(day.apiCost, 0)
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.equal(writes, 1, 'already-migrated persisted state schedules nothing more')
  assert.equal(readFileSync(path, 'utf8'), persisted, 'disk unchanged on the second run')
  assert.equal(readFileSync(backupPath, 'utf8'), original, 'backup unchanged on the second run')

  // A pre-existing backup is preserved, never overwritten (same contract as migration A).
  const sentinel = '{"pre-existing":true}'
  writeFileSync(backupPath, sentinel)
  ledger.migrations = []
  ledger.scheduleWrite = () => {}
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.equal(readFileSync(backupPath, 'utf8'), sentinel, 'existing backup preserved')
  rmSync(dir, { recursive: true, force: true })
})

test('subscription migration reprices the llm- wrapper route and leaves other providers alone', async () => {
  const { repairLedgerPricing, splitLedgerApiCost } = await lib('store.js')   // REAL functions, no stubs
  const block = migrationBlock(readFileSync(join(root, 'lib', 'index.js'), 'utf8'), 'subscription-provider-plan-reprice-v1')
  const wrapperKey = 'llm-command-code:xiaomi/mimo-v2.6-flash'
  // Decoy: an explicitly API-billed route whose model is priced in the catalog. Its cost must stay
  // untouched, otherwise the accept rule is repricing providers outside the three subscription routes.
  const decoyKey = 'llm-openrouter:meta/muse-spark-1.3-contributor'
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-migration-b-scope-'))
  const path = join(dir, 'ledger.json')
  const ledger = subscriptionLedgerFixture()
  const day = ledger.days['2026-09-25']
  day.byProviderModel = {
    [wrapperKey]: { ...subTokens, cost: 0, apiCost: 0 },
    [decoyKey]: { ...subTokens, cost: 0, apiCost: 0 },
  }
  day.sessions = []
  writeFileSync(path, JSON.stringify(ledger))
  ledger.path = path
  ledger.migrations = []
  ledger.scheduleWrite = () => {}
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.ok(Math.abs(day.byProviderModel[wrapperKey].cost - 1.2557265112) < 1e-9, 'llm- wrapper bucket repriced')
  assert.equal(day.byProviderModel[wrapperKey].apiCost, 0)
  assert.equal(day.byProviderModel[decoyKey].cost, 0, 'non-subscription bucket keeps its recorded cost')
  assert.equal(day.byProviderModel[decoyKey].apiCost, 0, 'non-subscription bucket keeps its API classification')
  assert.equal(day.apiCost, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('subscription migration moves already-priced subscription rows out of API spend', async () => {
  const { repairLedgerPricing, splitLedgerApiCost } = await lib('store.js')   // REAL functions, no stubs
  const block = migrationBlock(readFileSync(join(root, 'lib', 'index.js'), 'utf8'), 'subscription-provider-plan-reprice-v1')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-migration-b-priced-'))
  const path = join(dir, 'ledger.json')
  const ledger = subscriptionLedgerFixture()
  const day = ledger.days['2026-09-25']
  // Row already recorded at the current API-equivalent estimate: the repricer sees no difference and
  // leaves it alone, so only the API-spend split can move it out of cash spend.
  day.cost = 1.2557265112
  day.apiCost = 1.2557265112
  day.byProviderModel = { [subKey]: { ...subTokens, cost: 1.2557265112, apiCost: 1.2557265112 } }
  day.sessions = []
  writeFileSync(path, JSON.stringify(ledger))
  ledger.path = path
  ledger.migrations = []
  ledger.scheduleWrite = () => {}
  runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost)
  assert.equal(day.byProviderModel[subKey].cost, 1.2557265112, 'an already-correct estimate is not re-derived')
  assert.equal(day.byProviderModel[subKey].apiCost, 0, 'the row leaves API spend')
  assert.equal(day.apiCost, 0, 'the day container follows the bucket split')
  assert.equal(day.cost, 1.2557265112)
  rmSync(dir, { recursive: true, force: true })
})

// ── shared extraction/execution helpers (Task 5 appends migration-B tests using them) ──

/** Slice `if (!ledger.migrations.includes('<marker>')) { … }` out of lib/index.js. */
function migrationBlock(source, marker) {
  const anchor = source.indexOf(`ledger.migrations.includes('${marker}')`)
  assert.ok(anchor > 0, `lib/index.js carries the ${marker} migration`)
  const start = source.lastIndexOf('if (!ledger.migrations.includes', anchor)
  let depth = 0
  for (let i = source.indexOf('{', anchor); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated ${marker} block`)
}

/** Run the extracted wrapper with the REAL fs and the REAL repricer/API split. */
function runMigrationBlock(block, ledger, repairLedgerPricing, splitLedgerApiCost) {
  return new Function('ledger', 'fs', 'repairLedgerPricing', 'splitLedgerApiCost', 'console', block)(
    ledger, fs, repairLedgerPricing, splitLedgerApiCost, { log: () => {} },
  )
}

// ── Task 6: the requested locale reaches the text windows the host ships as data ──
//
// The balance prefixes and the gateway window labels are rendered verbatim by the client (they are
// data, not i18n keys), so the host must build them in the requested language. These cases call the
// real parsers, the real `queryCodingPlan`/`queryGatewayQuota` entry points behind a synthetic
// in-process transport, and the real `apply()` service — no stubbed parser, no test-only seam.

test('balance text windows follow the requested locale and pool knowledge', async () => {
  const { parseKimiBalance, parseSiliconFlowInfo, parseCommandCodeCredits } = await lib('coding-plans.js')
  assert.equal(parseKimiBalance({ available_balance: 12345 }, 'en').balance.text, 'Balance ¥123.45')
  assert.equal(parseKimiBalance({ available_balance: 12345 }, 'zh').balance.text, '余额 ¥123.45')
  assert.equal(parseKimiBalance({ available_balance: 12345 }).balance.text, '余额 ¥123.45', 'omitted locale keeps the zh default (upstream contract)')
  assert.equal(parseSiliconFlowInfo({ code: 0, data: { balance: 12.345 } }, 'en').balance.text, 'Balance ¥12.35')
  assert.equal(parseSiliconFlowInfo({ code: 0, data: { balance: 12.345 } }, 'zh').balance.text, '余额 ¥12.35')
  assert.equal(parseSiliconFlowInfo({ code: 0, data: { balance: 12.345 } }).balance.text, '余额 ¥12.35', 'omitted locale keeps the zh default (upstream contract)')
  const knownCaps = { windowLimits: { fiveHour: { cap: 16 }, weekly: { cap: 40 } } }
  const knownEn = parseCommandCodeCredits({ credits: { monthlyCredits: 38.91 }, ...knownCaps }, 'en')
  assert.equal(knownEn.balance.text, 'Balance $38.91')          // pool known → monthly % + balance text
  assert.equal(knownEn.monthly.percent, 51.4)
  const knownZh = parseCommandCodeCredits({ credits: { monthlyCredits: 38.91 }, ...knownCaps }, 'zh')
  assert.equal(knownZh.balance.text, '余额 $38.91')
  const unknownEn = parseCommandCodeCredits({ credits: { monthlyCredits: 5 } }, 'en')
  assert.equal(unknownEn.monthly.text, 'Balance $5.00')         // unknown caps → text window on monthly
  assert.equal(unknownEn.balance, undefined)
  const unknownZh = parseCommandCodeCredits({ credits: { monthlyCredits: 5 } }, 'zh')
  assert.equal(unknownZh.monthly.text, '余额 $5.00')
})

test('gateway window labels follow the locale through the parser and a mocked query', async () => {
  const { parseClaudeUsage, parseCodexUsage } = await lib('gateway-quota-adapters.js')
  const { queryGatewayQuota, GATEWAY_MANAGEMENT_PATHS } = await lib('gateway-quotas.js')

  // Parser level (real pinned interfaces): labels shipped as data.
  const claudeEn = parseClaudeUsage({ five_hour: { utilization: 42 } }, { locale: 'en' })
  assert.equal(claudeEn.windows[0].label, '5h')
  const claudeZh = parseClaudeUsage({ five_hour: { utilization: 42 } }, { locale: 'zh' })
  assert.equal(claudeZh.windows[0].label, '5 小时')
  const codexPayload = { rate_limit: { secondary_window: { used_percent: 34, limit_window_seconds: 604800 } } }
  assert.equal(parseCodexUsage(codexPayload, { locale: 'en' }).windows[0].label, 'Weekly')
  assert.equal(parseCodexUsage(codexPayload, { locale: 'zh' }).windows[0].label, '周')

  // Query level (mocked transport; fixture shape from the pinned test/gateway-retry.mjs).
  const source = { id: 'locale-test', type: 'cliproxyapi', baseURL: 'http://127.0.0.1:8317', enabled: true, display: 'both', includeProviders: ['claude'] }
  const ctx = { get: () => ({ resolve: async () => ({ value: 'mock-management-key' }) }) }
  const json = data => new Response(JSON.stringify(data), { status: 200 })
  const fetchImpl = async url => new URL(url).pathname === GATEWAY_MANAGEMENT_PATHS.authFiles
    ? json({ auth_files: [{ auth_index: 'test-auth', provider: 'claude' }] })
    : json({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 42 } }) })
  const en = await queryGatewayQuota(ctx, source, { locale: 'en', fetchImpl })
  assert.equal(en.accounts[0].windows[0].label, '5h')
  const zh = await queryGatewayQuota(ctx, source, { locale: 'zh', fetchImpl })
  assert.equal(zh.accounts[0].windows[0].label, '5 小时')
})

test('every gateway label branch follows the locale and non-en values fall back to zh', async () => {
  const { parseClaudeUsage, parseCodexUsage } = await lib('gateway-quota-adapters.js')
  const label = (payload, options) => parseCodexUsage(payload, options).windows[0].label
  const window = seconds => ({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: seconds } } })

  assert.deepEqual(
    [18000, 604800, 2592000, 10800].map(seconds => label(window(seconds), { locale: 'en' })),
    ['5h', 'Weekly', 'Monthly', '3h'],
  )
  assert.deepEqual(
    [18000, 604800, 2592000, 10800].map(seconds => label(window(seconds), { locale: 'zh' })),
    ['5h', '周', '月度', '3 小时'],
  )
  // Unlabelled windows fall back to their position; an unknown locale is treated as zh.
  const fallback = { rate_limit: { primary_window: { used_percent: 10 }, secondary_window: { used_percent: 20 } } }
  assert.deepEqual(parseCodexUsage(fallback, { locale: 'en' }).windows.map(w => w.label), ['Primary window', 'Secondary window'])
  assert.deepEqual(parseCodexUsage(fallback).windows.map(w => w.label), ['主窗口', '次窗口'])
  assert.equal(label(window(604800), { locale: 'fr' }), '周', 'only en selects the English labels')
  // `locale` must not disturb the other ctx fields.
  const relative = label({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 60 } } },
    { now: () => Date.parse('2026-09-02T00:00:00.000Z'), locale: 'en' })
  assert.equal(relative, 'Weekly')
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 60 } } },
    { now: () => Date.parse('2026-09-02T00:00:00.000Z'), locale: 'en' }).windows[0].resetsAt, '2026-09-02T00:01:00.000Z')

  const claudePayload = {
    five_hour: { utilization: 1 }, seven_day: { utilization: 2 }, seven_day_oauth_apps: { utilization: 3 },
    seven_day_opus: { utilization: 4 }, seven_day_sonnet: { utilization: 5 }, seven_day_cowork: { utilization: 6 },
    iguana_necktie: { utilization: 7 },
  }
  const pairs = result => result.windows.map(w => `${w.id}=${w.label}`)
  assert.deepEqual(pairs(parseClaudeUsage(claudePayload, { locale: 'en' })), [
    'five-hour=5h', 'seven-day=7d', 'seven-day-oauth-apps=7d OAuth Apps', 'seven-day-opus=7d Opus',
    'seven-day-sonnet=7d Sonnet', 'seven-day-cowork=7d Cowork', 'seven-day-fable=7d Fable',
  ])
  assert.deepEqual(pairs(parseClaudeUsage(claudePayload)), [
    'five-hour=5 小时', 'seven-day=7 天', 'seven-day-oauth-apps=7 天 OAuth Apps', 'seven-day-opus=7 天 Opus',
    'seven-day-sonnet=7 天 Sonnet', 'seven-day-cowork=7 天 Cowork', 'seven-day-fable=7 天 Fable',
  ])
  assert.equal(pairs(parseClaudeUsage(claudePayload, { locale: 'fr' }))[0], 'five-hour=5 小时')
})

test('queryCodingPlan hands the requested locale to the balance parsers', async () => {
  const { queryCodingPlan } = await lib('coding-plans.js')
  const originalFetch = globalThis.fetch          // the fail-closed guard
  const calls = []
  globalThis.fetch = async input => {
    const { pathname } = new URL(String(input))
    calls.push(pathname)
    if (pathname.endsWith('/alpha/billing/credits')) {
      return Response.json({
        credits: { monthlyCredits: 38.91 },
        windowLimits: { fiveHour: { used: 1, cap: 16, resetAt: 0 }, weekly: { used: 10, cap: 40, resetAt: 0 } },
      })
    }
    return new Response(null, { status: 404 })     // best-effort period lookup stays unavailable
  }
  try {
    const en = await queryCodingPlan('commandcode', 'cc-test-key', 'en', (_locale, code) => code)
    assert.equal(en.windows.balance.text, 'Balance $38.91', 'the query result carries the English prefix')
    const zh = await queryCodingPlan('commandcode', 'cc-test-key', 'zh', (_locale, code) => code)
    assert.equal(zh.windows.balance.text, '余额 $38.91')
    assert.equal(calls.filter(path => path.endsWith('/alpha/billing/credits')).length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the real host service passes its resolved locale into the gateway query', async () => {
  const { apply } = await lib('index.js')
  const work = mkdtempSync(join(tmpdir(), 'dsh-fork-gateway-locale-'))
  const savedHome = process.env.DSH_HOME
  const originalFetch = globalThis.fetch          // the fail-closed guard
  const effects = []
  const events = new Map()
  let service
  try {
    process.env.DSH_HOME = work
    const gatewaySource = {
      id: 'locale-test', type: 'cliproxyapi', label: 'Locale gateway', baseURL: 'http://127.0.0.1:8317',
      enabled: true, display: 'both', refreshMinutes: 15, includeProviders: ['claude'], allowedHosts: [],
      allowInsecureHttp: false, antigravityOnlyGemini: false,
    }
    mkdirSync(join(work, 'storages', 'cost-meter'), { recursive: true })
    writeFileSync(join(work, 'storages', 'cost-meter', 'ledger.json'), JSON.stringify({
      version: 1, days: {}, config: { locale: 'en', gatewayQuotas: { sources: [gatewaySource] } },
    }))
    const calls = []
    globalThis.fetch = async input => {
      const { pathname } = new URL(String(input))
      calls.push(pathname)
      return pathname === '/v0/management/auth-files'
        ? Response.json({ auth_files: [{ auth_index: 'test-auth', provider: 'claude' }] })
        : Response.json({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 42 } }) })
    }
    apply({
      get: name => name === 'credentials' ? { resolve: async () => ({ value: 'mock-management-key', source: 'test' }) } : undefined,
      provide: (name, value) => { if (name === 'costMeter') service = value },
      on: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name)?.delete(fn) },
      effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
      inject() {},
    })
    const labelOf = state => state.gatewayQuotas?.[0]?.accounts?.[0]?.windows?.[0]?.label
    const en = await service.refreshGatewayQuota('locale-test')
    assert.equal(en.ok, true, 'the mocked management endpoints answer')
    assert.match(en.message, /refreshed/i, 'the host really is in its English locale')
    assert.deepEqual(calls, ['/v0/management/auth-files', '/v0/management/api-call'])
    assert.equal(labelOf(en.state), '5h', 'the configured locale reaches the shipped window label')
    await service.updateConfig({ locale: 'zh' })
    const zh = await service.refreshGatewayQuota('locale-test')
    assert.equal(labelOf(zh.state), '5 小时', 'switching the language relabels the same payload')
  } finally {
    for (const dispose of effects.splice(0).reverse()) dispose()
    globalThis.fetch = originalFetch
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmSync(work, { recursive: true, force: true })
  }
})
