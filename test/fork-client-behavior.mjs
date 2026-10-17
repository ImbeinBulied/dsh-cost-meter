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
// browser receives; Task 9 needs it for the classifier/backfill tests.
const { sanitizeConfig } = await lib('store.js')
assert.equal(typeof sanitizeConfig, 'function', 'lib/store.js exports sanitizeConfig for later tasks')
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

/** localStorage shim: the helpers accept an injected storage in tests, window.localStorage in the app. */
const mapStorage = map => ({
  getItem: key => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
})

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
