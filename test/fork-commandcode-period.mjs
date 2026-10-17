// TEST-ONLY pins for the fork's Command Code monthly pool bar, subscription period boundaries
// and the host snapshot schema field that carries periodStartAt to the client card.
//
// Every provider response below is an in-process synthetic mock: `globalThis.fetch` is stubbed per
// test and restored to the fail-closed guard in `finally`. The isolation fixtures run BEFORE any
// lib/* import (the NODE_OPTIONS preload already redirects HOME/USERPROFILE/DSH_HOME/XDG_*; the
// in-process fixture reuses that root), so nothing here can read real profiles or reach the network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { failClosedFetch, syntheticEnv } from './helpers/synthetic-env.mjs'

// Isolation first — before any lib/* import: synthetic HOME/DSH_HOME/XDG dirs, fail-closed fetch.
syntheticEnv()
const restoreFetch = failClosedFetch()
process.once('exit', restoreFetch)

const root = fileURLToPath(new URL('..', import.meta.url))
const { commandcodeMonthlyPool, parseCommandCodeCredits, queryCodingPlan } =
  await import(pathToFileURL(join(root, 'lib', 'coding-plans.js')).href)
const { stateSchema } = await import(pathToFileURL(join(root, 'lib', 'typert.host.js')).href)

async function queryWithFetch(fetchImpl) {
  const originalFetch = globalThis.fetch        // the fail-closed guard
  globalThis.fetch = fetchImpl
  try {
    return await queryCodingPlan('commandcode', 'cc-test-key', 'en', (_locale, code) => code)
  } finally {
    globalThis.fetch = originalFetch             // back to the guard, never the real network
  }
}

const creditsResponse = () => Response.json({
  credits: { monthlyCredits: 38.91 },
  windowLimits: {
    fiveHour: { used: 1, cap: 16, resetAt: Date.parse('2026-10-01T00:00:00Z') },
    weekly: { used: 10, cap: 40, resetAt: Date.parse('2026-10-04T00:00:00Z') },
  },
})

test('caps table maps to the CommandCode monthly pool', () => {
  assert.equal(commandcodeMonthlyPool({ fiveHour: { cap: 3 }, weekly: { cap: 6 } }), 10)
  assert.equal(commandcodeMonthlyPool({ fiveHour: { cap: 14 }, weekly: { cap: 35 } }), 70)
  assert.equal(commandcodeMonthlyPool({ fiveHour: { cap: 16 }, weekly: { cap: 40 } }), 80)
  assert.equal(commandcodeMonthlyPool({ '5h': { cap: 45 }, '7d': { cap: 90 } }), 150)
  assert.equal(commandcodeMonthlyPool({ fiveHour: { cap: 90 }, weekly: { cap: 180 } }), 300)
  assert.equal(commandcodeMonthlyPool({ fiveHour: { cap: 12 }, weekly: { cap: 24 } }), 40)
  assert.equal(commandcodeMonthlyPool({ fiveHour: { cap: 99 }, weekly: { cap: 1 } }), null)
  assert.equal(commandcodeMonthlyPool(null), null)
  assert.equal(commandcodeMonthlyPool([]), null)
})

test('monthly credits render as a pool percent when the caps are known', () => {
  const windows = parseCommandCodeCredits({
    credits: { monthlyCredits: 38.91 },
    windowLimits: { fiveHour: { used: 1, cap: 16, resetAt: 0 }, weekly: { used: 10, cap: 40, resetAt: 0 } },
  }, 'en')
  assert.equal(windows.monthly.percent, 51.4)   // (80 − 38.91) / 80
  assert.equal(windows.monthly.resetsAt, '')
  assert.equal(windows.balance.text, 'Balance $38.91')
})

test('unknown caps fall back to a plain text window and fabricate no denominator', () => {
  const windows = parseCommandCodeCredits({
    credits: { monthlyCredits: 38.91 },
    windowLimits: { fiveHour: { used: 1, cap: 99, resetAt: 0 }, weekly: { used: 10, cap: 1, resetAt: 0 } },
  }, 'en')
  assert.equal(windows.monthly.percent, undefined)
  assert.match(windows.monthly.text, /38\.91/)
})

test('Command Code monthly reset uses subscription currentPeriodEnd and orgId', async () => {
  const calls = []
  const result = await queryWithFetch(async (input, init) => {
    const url = new URL(String(input))
    calls.push({ pathname: url.pathname, orgId: url.searchParams.get('orgId'), authorization: new Headers(init?.headers).get('authorization') })
    if (url.pathname.endsWith('/alpha/billing/credits')) return creditsResponse()
    if (url.pathname.endsWith('/alpha/whoami')) return Response.json({ org: { id: 'org-123' } })
    if (url.pathname.endsWith('/alpha/billing/subscriptions')) {
      return Response.json({ data: { currentPeriodStart: '2026-09-15T14:12:45.000Z', currentPeriodEnd: '2026-10-15T14:12:45.000Z' } })
    }
    return new Response(null, { status: 404 })
  })
  assert.equal(result.windows.monthly.percent, 51.4)
  assert.equal(result.windows.fiveHour.percent, 6.3)
  assert.equal(result.windows.monthly.periodStartAt, '2026-09-15T14:12:45.000Z')
  assert.equal(result.windows.monthly.resetsAt, '2026-10-15T14:12:45.000Z')
  assert.deepEqual(calls.map(({ pathname }) => pathname), ['/alpha/billing/credits', '/alpha/whoami', '/alpha/billing/subscriptions'])
  assert.equal(calls[2].orgId, 'org-123')
  assert.ok(calls.every(({ authorization }) => authorization === 'Bearer cc-test-key'))
})

test('Command Code omits orgId and keeps reset unavailable when subscription data fails', async () => {
  let subscriptionsUrl
  let discarded = false                       // the failing response body must be released, not leaked
  const failingBody = () => new Response(new ReadableStream({ cancel() { discarded = true } }), { status: 503 })
  const result = await queryWithFetch(async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/alpha/billing/credits')) return creditsResponse()
    if (url.pathname.endsWith('/alpha/whoami')) return Response.json({ org: null })
    if (url.pathname.endsWith('/alpha/billing/subscriptions')) { subscriptionsUrl = url; return failingBody() }
    return new Response(null, { status: 404 })
  })
  assert.equal(subscriptionsUrl.searchParams.has('orgId'), false)
  assert.equal(discarded, true)
  assert.equal(result.windows.monthly.percent, 51.4)
  assert.equal(result.windows.monthly.resetsAt, '')
})

test('Command Code releases the whoami body and stops before subscriptions when whoami fails', async () => {
  const calls = []
  let discarded = false
  const result = await queryWithFetch(async (input) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    if (url.pathname.endsWith('/alpha/billing/credits')) return creditsResponse()
    return new Response(new ReadableStream({ cancel() { discarded = true } }), { status: 503 })
  })
  assert.deepEqual(calls, ['/alpha/billing/credits', '/alpha/whoami'])
  assert.equal(discarded, true)
  assert.equal(result.windows.monthly.percent, 51.4)
  assert.equal(result.windows.monthly.resetsAt, '')
  assert.equal(result.windows.monthly.periodStartAt, undefined)
})

test('Command Code skips the subscription lookups when no monthly window exists', async () => {
  const calls = []
  const result = await queryWithFetch(async (input) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    if (url.pathname.endsWith('/alpha/billing/credits')) {
      return Response.json({ windowLimits: { fiveHour: { used: 8, cap: 16, resetAt: 0 } } })
    }
    return new Response(null, { status: 503 })
  })
  assert.equal(result.windows.fiveHour.percent, 50)
  assert.equal(result.windows.monthly, undefined)
  assert.deepEqual(calls, ['/alpha/billing/credits'])
})

test('Command Code period start survives the host snapshot schema', async () => {
  const periodStartAt = '2026-09-15T14:12:45.000Z'
  const parsed = stateSchema.shape.codingPlans.parse({
    commandcode: {
      enabled: true, display: 'sidebar', refreshMinutes: 5, apiKey: '', status: 'ok', message: '', fetchedAt: 0,
      windows: { monthly: { percent: 44.9, resetsAt: '2026-10-15T14:12:45.000Z', periodStartAt } },
    },
  })
  assert.equal(parsed.commandcode.windows.monthly.periodStartAt, periodStartAt)
})
