// TEST-ONLY: Task 7 -- rendered picker behavior in the real components (VM harness idiom from the
// pinned upstream test/model-quota-cards.mjs). The harness rewrites only its own in-memory copy of
// the concatenated fragments, never the generated artifact; production exports stay untouched.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { failClosedFetch, syntheticEnv } from './helpers/synthetic-env.mjs'

const env = syntheticEnv()
const restoreFetch = failClosedFetch()
process.once('exit', restoreFetch)

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readdirSync(join(root, 'src/client')).filter(n => n.endsWith('.js')).sort()
  .map(n => readFileSync(join(root, 'src/client', n), 'utf8')).join('')

// Test-only exposure: the VM rewrites the test's own copy of the bundled source (production exports
// are untouched). Components under test plus a cache setter so the Codex card renders without
// driving its async probe.
const EXPOSE = ['CodingPlanBox', 'QuotaStrip', 'GoQuotaBox', 'SidebarFooter', 'MiniMaxPlanBox', 'CodexPlanBox', 'PlanQuotaCard', 'QuotaCard']
const TEST_SETTERS = 'setCodexCache: cache => Object.assign(codexQuotaCache, cache)'

const element = (type, props, ...children) => ({ type, props: props ?? {}, children })
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.children)] : []
const countClass = (tree, cls) => nodes(tree).filter(n => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls)).length
// React elements carry `key` inside props (element shape is { type, props, children }).
const rowKeys = tree => nodes(tree).filter(n => typeof n.props?.className === 'string' && n.props.className.includes('cm-mm-row')).map(n => n.props.key)
const textOf = value => Array.isArray(value) ? value.map(textOf).join(' ')
  : value && typeof value === 'object' ? textOf(value.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : ''
/** Tooltip labels are plain strings in the harness's Tooltip stub. */
const tooltipLabels = tree => nodes(tree).filter(n => typeof n.props?.label === 'string').map(n => n.props.label)

function environment() {
  let factory, current
  const now = Date.parse('2026-10-01T00:00:00Z')
  class Clock extends Date { static now() { return now } }
  const storage = new Map()
  const React = {
    createElement: element,
    Fragment: 'fragment',
    useState(init) {
      const owner = current, i = owner.cursor++
      owner.slots[i] ??= { value: typeof init === 'function' ? init() : init }
      return [owner.slots[i].value, update => {
        owner.slots[i].value = typeof update === 'function' ? update(owner.slots[i].value) : update
      }]
    },
    useRef(value) { const owner = current, i = owner.cursor++; return owner.slots[i] ??= { current: value } },
    useEffect() {},
    useMemo(compute) { return compute() },
    useCallback(callback) { return callback },
    useSyncExternalStore(_subscribe, get) { return get() },
  }
  vm.runInNewContext(source.replace('exports.apply = apply', `exports.test = { ${EXPOSE.join(', ')}, ${TEST_SETTERS} }; exports.apply = apply`), {
    navigator: { language: 'en' },
    console,
    AbortSignal,
    Date: Clock,
    document: { hidden: false, visibilityState: 'visible', querySelector: () => ({}), addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    window: {
      __ModuleLoader__: { load: value => { factory = value.factory } },
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    },
    fetch: async () => { throw new Error('no network in render tests') },
  })
  const module = factory(name => name === 'react' ? React : { Tooltip: 'tooltip' })
  return {
    module,
    storage,
    render(component, props) {
      current = { slots: [], cursor: 0 }
      const tree = component(props)
      current = null
      return tree
    },
    /** Mount a stateful component: the same hook slots survive re-renders, as in React. */
    mount(component, props) {
      const owner = { slots: [], cursor: 0, props, tree: null }
      owner.render = next => { current = owner; owner.tree = component(next ?? owner.props); current = null; return owner.tree }
      owner.tree = owner.render(props)
      return owner
    },
  }
}

const baseState = (config, codingPlans) => ({
  config,
  today: { cost: 0, apiCost: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  month: { cost: 0, apiCost: 0 }, total: { cost: 0, apiCost: 0 },
  history: [], balance: { status: 'off' }, goQuota: { status: 'off' },
  codingPlans, gatewayQuotas: { sources: [] },
})

test('sidebar plan rows follow the stored picker selection', () => {
  const { module, storage, render } = environment()
  const state = baseState({
    locale: 'en',
    codingPlans: { anthropic: { enabled: true, display: 'sidebar' } },
  }, {
    anthropic: { status: 'ok', fetchedAt: 0, windows: { fiveHour: { percent: 5, resetsAt: '' }, weekly: { percent: 40, resetsAt: '' } } },
  })
  const box = props => render(module.test.CodingPlanBox, props)
  assert.deepEqual(rowKeys(box({ id: 'anthropic', state, wide: true })), ['fiveHour', 'weekly'])
  // Narrow rail text: default caps at the first 2 percentages, an explicit pick raises the cap.
  const three = baseState({ locale: 'en', codingPlans: { anthropic: { enabled: true, display: 'sidebar' } } }, {
    anthropic: { status: 'ok', fetchedAt: 0, windows: { fiveHour: { percent: 5, resetsAt: '' }, weekly: { percent: 40, resetsAt: '' }, monthly: { percent: 90, resetsAt: '' } } },
  })
  const rail = () => render(module.test.CodingPlanBox, { id: 'anthropic', state: three, wide: false })
  assert.equal(countClass(rail(), 'cm-bbox-rail'), 1)
  assert.equal(textOf(rail()).trim(), '5% 40%')
  assert.deepEqual(rowKeys(render(module.test.CodingPlanBox, { id: 'anthropic', state: three, wide: true })), ['fiveHour', 'weekly', 'monthly'])
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ anthropic: 'weekly' }))
  assert.deepEqual(rowKeys(box({ id: 'anthropic', state, wide: true })), ['weekly'])
  assert.equal(textOf(rail()).trim(), '40%', 'a pick narrows the rail to the chosen windows')
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ anthropic: 'fiveHour,weekly,monthly' }))
  assert.equal(textOf(rail()).trim(), '5% 40% 90%')
})

test('composer strip shows 2 percent segments by default and all of them for an explicit pick', () => {
  const { module, storage, render } = environment()
  const state = baseState({
    locale: 'en',
    quotaStrip: { enabled: true, budget: false, go: false, plans: true },
    codingPlans: { anthropic: { enabled: true, display: 'both' } },
  }, {
    anthropic: { status: 'ok', fetchedAt: 0, windows: {
      fiveHour: { percent: 10, resetsAt: '' }, weekly: { percent: 20, resetsAt: '' }, monthly: { percent: 30, resetsAt: '' },
    } },
  })
  const strip = () => render(module.test.QuotaStrip, { useCost: pick => pick({ state }) })
  assert.equal(countClass(strip(), 'cm-qseg'), 2)
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ anthropic: 'fiveHour,weekly,monthly' }))
  assert.equal(countClass(strip(), 'cm-qseg'), 3)
  // 'all' is an explicit pick too: the cap only applies while no choice is stored.
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ anthropic: 'all' }))
  assert.equal(countClass(strip(), 'cm-qseg'), 3)
  // A single-window pick still renders that window's segment (the cap cannot eat the whole chip).
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ anthropic: 'monthly' }))
  const single = strip()
  assert.equal(countClass(single, 'cm-qseg'), 1)
  assert.match(textOf(single), /30%/)
  storage.set('dsh-cost-meter.windowPick', '{not json')
  assert.equal(countClass(strip(), 'cm-qseg'), 2, 'corrupt storage falls back to the default cap')
})

test('text-only windows render the Chinese balance prefix in the active locale', () => {
  const { module, render } = environment()
  const windows = { balance: { text: '余额 $38.91' } }
  const zh = baseState({ locale: 'zh', codingPlans: { anthropic: { enabled: true, display: 'sidebar' } } }, { anthropic: { status: 'ok', fetchedAt: 0, windows } })
  const en = baseState({ locale: 'en', codingPlans: { anthropic: { enabled: true, display: 'sidebar' } } }, { anthropic: { status: 'ok', fetchedAt: 0, windows } })
  assert.match(textOf(render(module.test.CodingPlanBox, { id: 'anthropic', state: zh, wide: true })), /余额 \$38\.91/)
  const card = render(module.test.CodingPlanBox, { id: 'anthropic', state: en, wide: true })
  assert.match(textOf(card), /Balance \$38\.91/)
  assert.doesNotMatch(textOf(card), /余额/)
  assert.match(textOf(render(module.test.CodingPlanBox, { id: 'anthropic', state: en, wide: false })), /Balance \$38\.91/, 'narrow rail text follows the locale too')
  const stripState = baseState({
    locale: 'en',
    quotaStrip: { enabled: true, budget: false, go: false, plans: true },
    codingPlans: { anthropic: { enabled: true, display: 'both' } },
  }, { anthropic: { status: 'ok', fetchedAt: 0, windows } })
  const strip = render(module.test.QuotaStrip, { useCost: pick => pick({ state: stripState }) })
  assert.match(textOf(strip), /Balance \$38\.91/)
  assert.ok(tooltipLabels(strip).some(label => label.includes('Balance $38.91')), 'strip tooltip detail follows the locale')
})

test('settings picker toggles the stored selection and re-renders its button states', () => {
  const { module, mount, storage } = environment()
  const live = { anthropic: { status: 'ok', fetchedAt: 0, windows: {
    fiveHour: { percent: 5, resetsAt: '' }, weekly: { percent: 40, resetsAt: '' }, monthly: { percent: 90, resetsAt: '' },
  } } }
  const state = baseState({ locale: 'en', codingPlans: { anthropic: { enabled: true, display: 'settings' } } }, live)
  const labels = { goShortWeekly: 'Weekly', goShortMonthly: 'Monthly' }
  const card = mount(module.test.PlanQuotaCard, {
    state, api: {}, t: key => labels[key] ?? key, draft: state.config, setDraft: () => {}, planId: 'anthropic', labelKey: 'codingPlanAnthropic',
  })
  // The picker lives in the card's collapsed configNode; the QuotaCard shell is mounted open and
  // re-synced from the fresh configNode after every toggle (as the settings list does on re-render).
  const shell = mount(module.test.QuotaCard, { ...card.tree.props, open: true })
  const sync = () => {
    card.render()
    shell.render({ ...card.tree.props, open: true })
  }
  const body = () => nodes(shell.tree).find(n => n.props?.className === 'cm-pick-row')
  const pickButtons = () => nodes(body()).filter(n => n.type === 'button')
  const labelsOf = () => pickButtons().map(n => textOf(n).trim().replace(/\s+/g, ' '))
  const stored = () => JSON.parse(storage.get('dsh-cost-meter.windowPick') ?? '{}').anthropic ?? null
  assert.deepEqual(labelsOf(), ['5h ·', 'Weekly ·', 'Monthly ·'], 'no stored pick = neutral state')
  assert.deepEqual(pickButtons().map(n => n.props.className.includes('cm-pick-on') || n.props.className.includes('cm-pick-off')), [false, false, false])
  // Contract (persisted-string format): from the neutral state a click hides that one window
  // (selection = all-minus-clicked), a further click re-adds it, and a complete/empty selection
  // stores null = default again.
  pickButtons()[1].props.onClick()
  sync()
  assert.equal(stored(), 'fiveHour,monthly', 'first click hides just that window')
  assert.deepEqual(labelsOf(), ['5h ✓', 'Weekly ✕', 'Monthly ✓'], 'click re-renders every button state')
  assert.equal(pickButtons()[1].props.className.includes('cm-pick-off'), true)
  assert.equal(pickButtons()[0].props.className.includes('cm-pick-on'), true)
  assert.equal(pickButtons()[1].props.title, 'cmPickToggleHint', 'button carries the toggle hint')
  pickButtons()[1].props.onClick()
  sync()
  assert.equal(stored(), null, 're-adding the last hidden window stores the default')
  assert.deepEqual(labelsOf(), ['5h ·', 'Weekly ·', 'Monthly ·'], 'default restores the neutral state')
  pickButtons()[0].props.onClick()
  sync()
  pickButtons()[2].props.onClick()
  sync()
  assert.equal(stored(), 'weekly', 'hiding both outer windows keeps the middle one (table order)')
  assert.deepEqual(labelsOf(), ['5h ✕', 'Weekly ✓', 'Monthly ✕'])
  pickButtons()[0].props.onClick()
  sync()
  assert.equal(stored(), 'fiveHour,weekly', 'adding a later-positioned key keeps table order')
  pickButtons()[2].props.onClick()
  sync()
  assert.equal(stored(), null, 'selecting every window stores the default (null)')
  pickButtons()[2].props.onClick()
  sync()
  assert.equal(stored(), 'fiveHour,weekly', 'hiding from a complete selection narrows it')
})

test('sidebar footer plan card follows the stored picker selection', () => {
  const { module, render, storage } = environment()
  const codingPlans = {
    anthropic: { status: 'ok', fetchedAt: 0, windows: { fiveHour: { percent: 5, resetsAt: '' }, weekly: { percent: 40, resetsAt: '' } } },
  }
  const config = { locale: 'en', codingPlans: { anthropic: { enabled: true, display: 'sidebar' } } }
  const state = baseState(config, codingPlans)
  // The footer builds element descriptors; render the plan card with the props the footer passes.
  const footerCard = () => nodes(render(module.test.SidebarFooter, { wide: true, useCost: pick => pick({ state }) }))
    .find(n => n.type === module.test.CodingPlanBox)
  assert.ok(footerCard(), 'footer includes the plan card for a sidebar-enabled plan')
  assert.equal(footerCard().props.id, 'anthropic')
  const card = () => render(module.test.CodingPlanBox, footerCard().props)
  assert.deepEqual(rowKeys(card()), ['fiveHour', 'weekly'], 'footer renders the plan card with every window by default')
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ anthropic: 'weekly' }))
  assert.deepEqual(rowKeys(card()), ['weekly'], 'the sidebar rail selection reaches the footer path')
})

test('an explicit monthly pick keeps the CommandCode monthly window findable', () => {
  const { module, render, storage } = environment()
  // CC may expose more windows than the strip cap. Its card deliberately bypasses the picker so
  // monthly stays reachable (per the module's documented rule): the CC card body leads with the
  // monthly metric and summarises the other percent windows on one line, whatever the stored pick
  // says; the composer strip still honours an explicit pick and stops truncating it at the default
  // two segments. Task 8 turned the CC body from mm-rows into that single-window card, so the
  // assertions read the rendered text instead of the old row keys.
  const state = baseState({
    locale: 'en',
    quotaStrip: { enabled: true, budget: false, go: false, plans: true },
    codingPlans: { commandcode: { enabled: true, display: 'both' } },
  }, {
    commandcode: { status: 'ok', fetchedAt: 0, windows: {
      fiveHour: { percent: 10, resetsAt: '' }, weekly: { percent: 20, resetsAt: '' }, monthly: { percent: 30, resetsAt: '' },
    } },
  })
  const box = () => textOf(render(module.test.CodingPlanBox, { id: 'commandcode', state, wide: true }))
  assert.match(box(), /CC Mo 30%/, 'unpicked card leads with the monthly window')
  assert.match(box(), /5h 10% · Wk 20%/, 'the other percent windows stay summarised')
  assert.equal(textOf(render(module.test.CodingPlanBox, { id: 'commandcode', state, wide: false })).trim(), '30%', 'the rail carries the monthly metric')
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ commandcode: 'monthly' }))
  assert.match(box(), /CC Mo 30%/, 'CC card bypass keeps the monthly window findable under a pick')
  const strip = render(module.test.QuotaStrip, { useCost: pick => pick({ state }) })
  assert.equal(countClass(strip, 'cm-qseg'), 1, 'the strip still honours the explicit pick')
  assert.match(textOf(strip), /30%/)
})

test('settings text windows follow the active locale too', () => {
  const { module, mount } = environment()
  const windows = { balance: { text: '余额 $38.91' } }
  const render = locale => {
    const state = baseState({ locale, codingPlans: { anthropic: { enabled: true, display: 'settings' } } }, { anthropic: { status: 'ok', fetchedAt: 0, windows } })
    return mount(module.test.PlanQuotaCard, {
      state, api: {}, t: key => key, draft: state.config, setDraft: () => {}, planId: 'anthropic', labelKey: 'codingPlanAnthropic',
    }).tree.props.statusNode
  }
  assert.match(textOf(render('zh')), /余额 \$38\.91/)
  const en = render('en')
  assert.match(textOf(en), /Balance \$38\.91/)
  assert.doesNotMatch(textOf(en), /余额/)
})

test('Codex and Go cards ignore the coding-plan picker storage', () => {
  const { module, render, storage } = environment()
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ codex: 'all', go: 'rolling' }))
  const state = baseState({
    locale: 'en', codexQuotaEnabled: true,
    codingPlans: { minimax: { enabled: true, display: 'sidebar' } },
    goQuota: { enabled: true },
  }, {})
  state.goQuota = { status: 'ok', rolling: { percent: 10 }, weekly: { percent: 20 }, monthly: { percent: 30 } }
  assert.ok(render(module.test.GoQuotaBox, { state, wide: true }), 'Go card still renders under a picker map')
  module.test.setCodexCache({ status: 'ok', windows: { weekly: { percent: 42, resetsAt: '' } }, fetchedAt: 0 })
  assert.match(textOf(render(module.test.CodexPlanBox, { state, wide: true })), /42%/, 'Codex card reads its own cache, never the picker map')
})

test('picker styles ship in the client stylesheet', () => {
  const css = readFileSync(join(root, 'src/client', '01-open-styles-i18n.js'), 'utf8')
  for (const rule of ["'.cm-pick-row{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 2px}'", "'.cm-pick-on{font-weight:600}'", "'.cm-pick-off{opacity:.45;text-decoration:line-through}'"]) {
    assert.ok(css.includes(rule), `stylesheet carries ${rule}`)
  }
})

// TEST-ONLY: Task 8 — pace/verdict card bodies (Go monthly anchor, Codex head/bar, CC API period)
// and the footer card order, rendered from the real components in the VM harness above.
test('the CC card renders the monthly bar with an API-period verdict and no guessed reset', () => {
  const { module, render } = environment()
  const stateWith = windows => baseState(
    { locale: 'en', codingPlans: { commandcode: { enabled: true, display: 'sidebar' } } },
    { commandcode: { status: 'ok', fetchedAt: 0, windows } },
  )
  // Symmetric period around the injected clock (2026-10-01T00:00:00Z): elapsed = 50% exactly,
  // so pct 40 → "Under pace by 10.0%" with no rounding ambiguity.
  const monthly = { percent: 40, resetsAt: '2026-10-16T00:00:00.000Z', periodStartAt: '2026-09-16T00:00:00.000Z' }
  const withPeriod = render(module.test.CodingPlanBox, {
    id: 'commandcode', wide: true,
    state: stateWith({
      monthly,
      fiveHour: { percent: 5, resetsAt: '2026-10-01T06:00:00.000Z' },
      balance: { text: '余额 $38.91' },
    }),
  })
  const withPeriodText = textOf(withPeriod)
  assert.match(withPeriodText, /40%/, 'monthly bar percent rendered')
  assert.match(withPeriodText, /Balance \$38\.91/, 'balance text window localised')
  assert.match(withPeriodText, /Pace \d+(\.\d+)?%\/day/, 'pace line rendered')
  assert.match(withPeriodText, /Under pace by 10\.0%/, 'verdict uses the API period boundaries')
  // The other percent windows are summarised (percent line) and their countdowns merge with the
  // balance text into ONE head row; the monthly reset keeps its own line (15d to 2026-10-16).
  const heads = () => nodes(withPeriod).filter(n => n.props?.className === 'cm-bbox-head')
  assert.equal(heads().length, 2, 'card head plus the merged other-resets/balance row')
  assert.match(textOf(heads()[1]), /5h 6h 0m left.*Balance \$38\.91/, 'their countdowns merge with the balance text')
  assert.match(textOf(withPeriod), /5h 5%/, 'the other percent windows stay summarised')
  const resetLine = nodes(withPeriod).find(n => n.props?.className === 'cm-bbox-line' && textOf(n).includes('(15d 0h left)'))
  assert.ok(resetLine && /Resets:/.test(textOf(resetLine)), 'the monthly reset renders on its own line')
  const withoutPeriod = render(module.test.CodingPlanBox, {
    id: 'commandcode', wide: true,
    state: stateWith({ monthly: { percent: 40, resetsAt: monthly.resetsAt }, fiveHour: { percent: 5, resetsAt: '2026-10-01T06:00:00.000Z' }, balance: { text: '余额 $38.91' } }),
  })
  const withoutPeriodText = textOf(withoutPeriod)
  assert.ok(!/pace by/i.test(withoutPeriodText), 'unknown period → no guessed verdict')
  assert.ok(!/NaN|undefined/.test(withoutPeriodText), 'no placeholder text leaks into the card')
  // 60% against the same half-elapsed period → "Over pace by 10.0%": the verdict leaves the plain
  // text form and renders the classed span the CSS colours.
  const overPace = render(module.test.CodingPlanBox, {
    id: 'commandcode', wide: true,
    state: stateWith({ monthly: { ...monthly, percent: 60 }, balance: { text: '余额 $38.91' } }),
  })
  const verdictSpan = nodes(overPace).find(n => typeof n.props?.className === 'string' && n.props.className.startsWith('cm-verdict '))
  assert.equal(verdictSpan?.props.className, 'cm-verdict over', 'over-pace verdict renders the coloured span')
  assert.equal(textOf(verdictSpan), 'Over pace by 10.0%')
  assert.equal(nodes(overPace).filter(n => n.props?.className === 'cm-bbox-head').length, 1, 'a balance with no other countdowns stays a plain line, not a merged head row')
})

test('the Go card drives pace/status from the monthly window even when the main window is rolling', () => {
  const { module, render } = environment()
  // mainKey = rolling (10%, resets in 10d → 9.0%/day if it were used); monthly 40%, resets in 2d → 30.0%/day.
  const state = baseState({
    locale: 'en',
    goQuota: { enabled: true, main: 'rolling' },
  }, {})
  state.goQuota = {
    status: 'ok',
    rolling: { percent: 10, resetsAt: '2026-10-11T00:00:00.000Z' },
    weekly: { percent: 20, resetsAt: '2026-10-11T00:00:00.000Z' },
    monthly: { percent: 40, resetsAt: '2026-10-03T00:00:00.000Z' },
  }
  const text = textOf(render(module.test.GoQuotaBox, { state, wide: true }))
  assert.match(text, /Pace 30\.0%\/day/, 'pace comes from the monthly window, not the rolling main window')
  assert.ok(!/Pace 9\.0%\/day/.test(text), 'rolling window must not drive pace')
  // 30-day anchor from the monthly reset: elapsed 28/30 → 93.3% expected vs 40% used.
  assert.match(text.replace(/\s+/g, ' '), /Pace 30\.0%\/day · Under pace by 53\.3%/, 'pace and verdict merge into one row')
})

test('the Codex card renders the Go-style head, bar, reset line and merged pace/verdict', () => {
  const { module, render } = environment()
  // Period start is exactly the injected clock (2026-10-01T00:00:00Z): elapsed = 0%, so pct 20 is
  // over pace by the full 20.0%. Also pins that a period starting exactly now is accepted.
  module.test.setCodexCache({ status: 'ok', fetchedAt: 0, windows: { weekly: { percent: 20, resetsAt: '2026-10-08T00:00:00.000Z' } } })
  const state = baseState({ locale: 'en', codexQuotaEnabled: true }, {})
  const card = render(module.test.CodexPlanBox, { state, wide: true })
  const text = textOf(card)
  assert.match(text, /ChatGPT \(Codex\) weekly quota/, 'head carries the title')
  assert.match(text, /20%/, 'head carries the used percent')
  assert.match(text, /Resets: .*\(7d 0h left\)/, 'reset line keeps the date plus countdown')
  assert.match(text.replace(/\s+/g, ' '), /Pace 11\.4%\/day · Over pace by 20\.0%/, 'pace and verdict merge into one row')
  const classes = nodes(card).map(n => n.props?.className).filter(c => typeof c === 'string')
  assert.ok(classes.includes('cm-bbox-bar'), 'Go-style bar is rendered directly')
  assert.ok(classes.includes('cm-verdict over'), 'over-pace verdict renders the coloured span')
  assert.ok(!classes.includes('cm-mm-title') && !classes.some(c => c.split(' ').includes('cm-mm')), 'the mm-row styling class is gone')
})

test('the rendered sidebar stacks the Codex card before the plan cards', () => {
  const { module, render } = environment()
  module.test.setCodexCache({ status: 'ok', windows: { weekly: { percent: 20, resetsAt: '' } }, fetchedAt: 0 })
  const state = baseState({
    locale: 'en',
    codexQuotaEnabled: true,
    codingPlans: { anthropic: { enabled: true, display: 'sidebar' }, minimax: { enabled: true, display: 'sidebar' } },
  }, {
    anthropic: { status: 'ok', fetchedAt: 0, windows: { fiveHour: { percent: 5, resetsAt: '' } } },
    minimax: { status: 'ok', fetchedAt: 0, windows: { '5h': { percent: 7, resetsAt: '' } } },
  })
  const footer = render(module.test.SidebarFooter, { useCost: pick => pick({ state }), wide: true })
  const cardName = type => type === module.test.CodexPlanBox ? 'codex'
    : type === module.test.MiniMaxPlanBox ? 'minimax'
      : type === module.test.CodingPlanBox ? 'plan' : null
  const order = nodes(footer).map(n => cardName(n.type)).filter(Boolean)
  // Codex first; then the plan rows in table order (anthropic before minimax), with MiniMax on its
  // own dedicated card; the gateway cards keep the tail (issue #96 path, unchanged).
  assert.deepEqual(order, ['codex', 'plan', 'minimax'], 'Codex card renders first, then the plan cards')
})

test('the rendered sidebar stacks Codex, then the CommandCode card, then Go', () => {
  // The fork's actual three-card stack: Codex probe card → CommandCode plan card → Go quota card.
  // Realistic fixture on every window (rolling/weekly/monthly incl. reset timestamps, the CC monthly
  // API period, and the goQuota snapshot the sidebar gate reads), each card rendered from the props
  // the footer passes so the order cannot be satisfied by an empty element.
  const { module, render } = environment()
  module.test.setCodexCache({ status: 'ok', fetchedAt: 0, windows: { weekly: { percent: 20, resetsAt: '2026-10-08T00:00:00.000Z' } } })
  const state = baseState({
    locale: 'en',
    hideTodayCost: true,
    codexQuotaEnabled: true,
    goQuota: { enabled: true, display: 'sidebar', main: 'rolling', detail: true },
    codingPlans: { commandcode: { enabled: true, display: 'sidebar' } },
  }, {
    commandcode: { status: 'ok', fetchedAt: 0, windows: {
      fiveHour: { percent: 10, resetsAt: '2026-10-01T06:00:00.000Z' },
      weekly: { percent: 20, resetsAt: '2026-10-05T00:00:00.000Z' },
      monthly: { percent: 30, resetsAt: '2026-10-16T00:00:00.000Z', periodStartAt: '2026-09-16T00:00:00.000Z' },
    } },
  })
  state.goQuota = {
    status: 'ok',
    fetchedAt: 0,
    rolling: { percent: 10, resetsAt: '2026-10-01T05:00:00.000Z' },
    weekly: { percent: 20, resetsAt: '2026-10-05T00:00:00.000Z' },
    monthly: { percent: 40, resetsAt: '2026-10-03T00:00:00.000Z' },
  }
  const footer = render(module.test.SidebarFooter, { useCost: pick => pick({ state }), wide: true })
  const stack = footer.children.filter(n => n !== null && typeof n === 'object')
  assert.deepEqual(stack.map(n => n.type), [module.test.CodexPlanBox, module.test.CodingPlanBox, module.test.GoQuotaBox], 'card order is Codex, CommandCode, Go')
  assert.equal(stack[1].props.id, 'commandcode', 'the middle card is the CommandCode plan card')
  assert.equal(stack[1].props.state, state)
  assert.equal(stack[2].props.wide, true)
  assert.ok(render(module.test.CodexPlanBox, stack[0].props), 'Codex card renders with the fixture')
  assert.match(textOf(render(module.test.CodingPlanBox, stack[1].props)), /CC Mo 30%/, 'CommandCode card renders its monthly view')
  assert.match(textOf(render(module.test.GoQuotaBox, stack[2].props)), /Go 5h 10%/, 'Go card renders its main window')
})

test('a text-only CommandCode snapshot still renders without the percent branch', () => {
  const { module, render } = environment()
  const state = baseState(
    { locale: 'en', codingPlans: { commandcode: { enabled: true, display: 'sidebar' } } },
    { commandcode: { status: 'ok', fetchedAt: 0, windows: { monthly: { text: '余额 $38.91', resetsAt: '' } } } },
  )
  const text = textOf(render(module.test.CodingPlanBox, { id: 'commandcode', state, wide: true }))
  assert.match(text, /Balance \$38\.91/, 'text window renders through the generic rows path')
  assert.ok(!/NaN|undefined|pace by/i.test(text), 'no guessed verdict or placeholder text')
})

test('a CommandCode pick that omits monthly still renders the monthly card and rail', () => {
  // Task 7 review regression: the CC card ignores the picker by design so the monthly window stays
  // findable — including when the stored pick explicitly lists other windows. The strip still
  // honours the pick, so the two surfaces disagree on purpose.
  const { module, render, storage } = environment()
  const state = baseState({
    locale: 'en',
    quotaStrip: { enabled: true, budget: false, go: false, plans: true },
    codingPlans: { commandcode: { enabled: true, display: 'both' } },
  }, {
    commandcode: { status: 'ok', fetchedAt: 0, windows: {
      fiveHour: { percent: 10, resetsAt: '' }, weekly: { percent: 20, resetsAt: '' }, monthly: { percent: 30, resetsAt: '' },
    } },
  })
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ commandcode: 'fiveHour,weekly' }))
  const cardText = textOf(render(module.test.CodingPlanBox, { id: 'commandcode', state, wide: true }))
  assert.match(cardText, /30%/, 'the card still shows the monthly window the pick omits')
  assert.match(cardText, /5h 10% · Wk 20%/, 'the other percent windows stay summarised on their own line')
  assert.equal(textOf(render(module.test.CodingPlanBox, { id: 'commandcode', state, wide: false })).trim(), '30%', 'the rail keeps the monthly metric')
  const strip = render(module.test.QuotaStrip, { useCost: pick => pick({ state }) })
  assert.equal(countClass(strip, 'cm-qseg'), 2, 'the strip renders only the picked windows')
  assert.doesNotMatch(textOf(strip), /30%/, 'the strip never shows the omitted monthly window')
})
