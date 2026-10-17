// TEST-ONLY (never shipped: the `files` allowlist excludes test/).
// Fork behavior pins for the Codex plan/API separation:
//   - the default classification of the `openai-codex` route (and its `llm-` host wrapper);
//   - `repairLedgerPricing`'s exact/standardTier options used by the one-time Codex migration;
//   - the Codex-alias branch of the OpenRouter repair;
//   - the `openai-codex-plan-reprice-v1` wrapper itself, sliced out of lib/index.js and executed
//     against real fs + the real repricer (backup-before-write, run-once, backup preservation).
// Everything runs on synthetic fixtures: a throwaway HOME/DSH_HOME/XDG layout, a fail-closed fetch
// guard and temp ledger files. No profile, credential, session or network surface is touched.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const { billingClassOf, DEFAULT_PLAN_PROVIDER_CLASS, planProviderIdOf } = await lib('plan-billing.js')
const { normalizePrice, providerPriceEntryFor } = await lib('pricing.js')
const { defaultConfig, repairLedgerPricing, sanitizeConfig } = await lib('store.js')
const { repairOpenRouterLedger } = await lib('openrouter-pricing.js')

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
