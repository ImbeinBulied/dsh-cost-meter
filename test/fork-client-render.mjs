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
  // monthly stays reachable (per the module's documented rule), while the composer strip still
  // honours an explicit pick and stops truncating it at the default two segments.
  const state = baseState({
    locale: 'en',
    quotaStrip: { enabled: true, budget: false, go: false, plans: true },
    codingPlans: { commandcode: { enabled: true, display: 'both' } },
  }, {
    commandcode: { status: 'ok', fetchedAt: 0, windows: {
      fiveHour: { percent: 10, resetsAt: '' }, weekly: { percent: 20, resetsAt: '' }, monthly: { percent: 30, resetsAt: '' },
    } },
  })
  const box = () => render(module.test.CodingPlanBox, { id: 'commandcode', state, wide: true })
  assert.deepEqual(rowKeys(box()), ['fiveHour', 'weekly', 'monthly'], 'unpicked card shows every CC window')
  assert.equal(textOf(render(module.test.CodingPlanBox, { id: 'commandcode', state, wide: false })).trim(), '10% 20%')
  storage.set('dsh-cost-meter.windowPick', JSON.stringify({ commandcode: 'monthly' }))
  assert.deepEqual(rowKeys(box()), ['fiveHour', 'weekly', 'monthly'], 'CC card bypass keeps every window (monthly stays findable)')
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
