import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/client/02-validators-helpers-sidebar.js', import.meta.url), 'utf8')
function helper() {
  const start = source.indexOf('    async function querySubscriptionsCodexQuota(')
  assert.ok(start >= 0, 'subscriptions Codex quota adapter exists')
  const end = source.indexOf('\n    const codexQuotaCache', start)
  assert.ok(end > start)
  return vm.runInNewContext(source.slice(start, end) + '\nquerySubscriptionsCodexQuota')
}

test('uses the default subscription account and converts weekly milliseconds', async () => {
  const calls = []
  const rpc = { async call(channel, method, payload) {
    calls.push({ channel, method, payload })
    return method.endsWith('.status')
      ? { ok: true, value: { providers: { codex: { accounts: [{ key: 'other' }, { key: 'selected', isDefault: true }] } } } }
      : { ok: true, value: { supported: true, windows: [{ kind: 'five-hour', usedPercent: 8 }, { kind: 'weekly', usedPercent: 32.5, resetsAt: 1800000000000 }] } }
  } }
  const windows = await helper()(rpc)
  assert.equal(windows.weekly.percent, 32.5)
  assert.equal(windows.weekly.resetsAt, new Date(1800000000000).toISOString())
  assert.equal(calls[0].channel, '/api')
  assert.equal(calls[1].method, 'subscriptions-auth.usage')
  assert.equal(calls[1].payload.account, 'selected')
  assert.equal(calls[1].payload.provider, 'codex')
})

test('missing plugin, signed-out accounts and invalid usage stay unavailable', async () => {
  const query = helper()
  assert.equal(await query(null), null)
  assert.equal(await query({ call: async () => ({ ok: false }) }), null)
  assert.equal(await query({ call: async () => ({ ok: true, value: { providers: { codex: { accounts: [] } } } }) }), null)
  for (const usedPercent of [NaN, Infinity, '12', undefined]) {
    const rpc = { call: async (_channel, method) => ({ ok: true, value: method.endsWith('.status')
      ? { providers: { codex: { accounts: [{ key: 'only' }] } } }
      : { supported: true, windows: [{ kind: 'weekly', usedPercent }] } }) }
    assert.equal(await query(rpc), null)
  }
})

function probe(rpc, fetch) {
  const start = source.indexOf("    const CODEX_STATUS_PATH =")
  const end = source.indexOf('    function useCodexQuota(', start)
  return vm.runInNewContext(source.slice(start, end) + '\ncodexQuotaRpc = rpc; ({ fetchCodexQuota, codexQuotaCache })', { rpc, fetch, AbortSignal })
}

test('the actual quota probe fills the card cache through subscriptions RPC', async () => {
  const rpc = { call: async (_channel, method) => ({ ok: true, value: method.endsWith('.status')
    ? { providers: { codex: { accounts: [{ key: 'default' }] } } }
    : { supported: true, windows: [{ kind: 'weekly', usedPercent: 42 }] } }) }
  const client = probe(rpc, () => assert.fail('working subscriptions must not request the legacy route'))
  await client.fetchCodexQuota(true, true)
  assert.equal(client.codexQuotaCache.status, 'ok')
  assert.equal(client.codexQuotaCache.windows.weekly.percent, 42)
})

test('a missing subscriptions method falls back to the legacy connector', async () => {
  const rpc = { call: async () => { throw new Error('method not found') } }
  const client = probe(rpc, async () => ({ ok: true, json: async () => ({ status: 'signed-in', usage: { rateLimits: [
    { id: 'codex', windows: [{ windowSeconds: 604800, remainingPercent: 75 }] },
  ] } }) }))
  await client.fetchCodexQuota(true, true)
  assert.equal(client.codexQuotaCache.status, 'ok')
  assert.equal(client.codexQuotaCache.windows.weekly.percent, 25)
})
