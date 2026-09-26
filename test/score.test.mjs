import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWindow, num, parseIsoDate, scanSeries, scorePages, statusFor } from '../src/index.mjs'
import { BASELINE, RECENT, pageRows, rowsFor } from './helpers.mjs'

const day = (iso) => {
  const parsed = parseIsoDate(iso)
  assert.equal(parsed.ok, true, iso)
  return parsed.day
}

const WINDOWS = {
  baseline: buildWindow(day(BASELINE.start), day(BASELINE.end), []),
  recent: buildWindow(day(RECENT.start), day(RECENT.end), []),
}

const POLICY = Object.freeze({
  metric: 'sessions',
  seriesComplete: true,
  minimumVolume: 200,
  minimumDays: 20,
  maxCoverageGapDays: 2,
  stalenessDays: 540,
  thresholds: Object.freeze({ decayRatio: 0.7, warnRatio: 0.9, linkRatio: 0.7, minimumLinks: 10 }),
})

/** Run the real reader over `rows`, then score. */
function score(rows, { freshness = new Map(), policy = POLICY, windows = WINDOWS } = {}) {
  const scan = scanSeries({ schemaVersion: '1', metric: 'sessions', rows }, {
    file: 'exports/analytics.json',
    metric: 'sessions',
    maxRows: 100000,
  })
  assert.deepEqual(scan.findings, [], 'the fixture rows must all be readable')
  return scorePages(scan.observations, freshness, windows, policy)
}

const ids = (result) => result.findings.map((finding) => finding.ruleId)

test('a falling sample with enough volume is flagged', () => {
  const result = score(pageRows('/guides/install', 60, 20))
  assert.deepEqual(ids(result), ['decline-over-threshold'])
  assert.equal(result.findings[0].severity, 'error')
  assert.equal(statusFor(result.findings), 'fail')
  assert.deepEqual(result.counts, { checked: 1, scored: 1, inconclusive: 0, declining: 1, observations: 60 })
  assert.match(result.findings[0].evidence, /baselineMean=60 recentMean=20 ratio=0.3333/u)
  assert.equal(result.findings[0].location.pointer, '/pages/~1guides~1install')
})

test('sparse data is inconclusive, not a pass', () => {
  // Four days of data, well under the 200 baseline total the policy requires.
  const rows = [
    ...rowsFor('/blog/old-post', BASELINE.start, 4, 6),
    ...rowsFor('/blog/old-post', RECENT.start, 4, 1),
  ]
  const result = score(rows)
  assert.deepEqual(ids(result), ['insufficient-volume'])
  assert.equal(result.findings[0].severity, 'warning')
  assert.equal(
    statusFor(result.findings),
    'incomplete',
    'a page the tool could not judge must never produce a pass',
  )
  assert.deepEqual(result.counts, { checked: 1, scored: 0, inconclusive: 1, declining: 0, observations: 8 })
  assert.match(result.findings[0].message, /not an absence of decline/u)
})

test('the ratio alone does not decide it: a steep sparse fall is still inconclusive', () => {
  // 24 -> 0 is a total collapse in the numbers, and it is still under the
  // minimum volume, so the honest answer is that there is not enough to say.
  const rows = [
    ...rowsFor('/blog/old-post', BASELINE.start, 24, 1),
    ...rowsFor('/blog/old-post', RECENT.start, 24, 0),
  ]
  const result = score(rows)
  assert.deepEqual(ids(result), ['insufficient-volume'])
  assert.equal(statusFor(result.findings), 'incomplete')
  assert.equal(result.counts.scored, 0)
})

test('minimum volume is what separates the two, and it is configurable', () => {
  const rows = [
    ...rowsFor('/blog/old-post', BASELINE.start, 24, 5),
    ...rowsFor('/blog/old-post', RECENT.start, 24, 1),
  ]
  assert.deepEqual(ids(score(rows)), ['insufficient-volume'], '120 total is under the default minimum of 200')
  const lowered = score(rows, { policy: { ...POLICY, minimumVolume: 100 } })
  assert.deepEqual(ids(lowered), ['decline-over-threshold'], 'the same sample scores once the minimum allows it')
  assert.equal(statusFor(lowered.findings), 'fail')
})

test('a baseline of zero is inconclusive whatever the minimum volume is', () => {
  // scorePages is public API and uses the policy it is handed. The CLI never
  // supplies a minimum below 1, but a caller can, and then only the explicit
  // zero arm of the volume gate stands between a baseline mean of 0 and a
  // ratio of Infinity or NaN being reported as a comparison of two windows.
  const permissive = { ...POLICY, minimumVolume: 0 }
  const fell = score([
    ...rowsFor('/p', BASELINE.start, 30, 0),
    ...rowsFor('/p', RECENT.start, 30, 5),
  ], { policy: permissive })
  assert.deepEqual(ids(fell), ['insufficient-volume'])
  assert.equal(statusFor(fell.findings), 'incomplete')
  assert.equal(fell.counts.scored, 0)

  const flat = score([
    ...rowsFor('/p', BASELINE.start, 30, 0),
    ...rowsFor('/p', RECENT.start, 30, 0),
  ], { policy: permissive })
  assert.deepEqual(ids(flat), ['insufficient-volume'], 'nor is 0 against 0 a comparison')
  assert.equal(flat.counts.scored, 0)
})

test('a page short of the coverage minimum is inconclusive even with the volume', () => {
  const rows = [
    ...rowsFor('/guides/install', BASELINE.start, 10, 100),
    ...rowsFor('/guides/install', RECENT.start, 10, 10),
  ]
  const result = score(rows)
  assert.deepEqual(ids(result), ['insufficient-coverage'])
  assert.equal(result.findings[0].severity, 'warning')
  assert.equal(statusFor(result.findings), 'incomplete')
  assert.equal(result.counts.scored, 0)
})

test('two windows with unlike coverage are not compared', () => {
  const rows = [
    ...rowsFor('/guides/install', BASELINE.start, 30, 20),
    ...rowsFor('/guides/install', RECENT.start, 22, 6),
  ]
  const result = score(rows)
  assert.deepEqual(ids(result), ['window-coverage-mismatch'])
  assert.equal(result.findings[0].severity, 'warning')
  assert.equal(statusFor(result.findings), 'incomplete')
  assert.match(result.findings[0].message, /a gap of 8 over the configured maximum of 2/u)
  const tolerant = score(rows, { policy: { ...POLICY, maxCoverageGapDays: 8 } })
  assert.deepEqual(ids(tolerant), ['decline-over-threshold'], 'raising the bound deliberately allows the comparison')
})

test('a page with two rows for one day is ambiguous and is not scored', () => {
  const rows = [...pageRows('/guides/install', 40, 38), { page: '/guides/install', date: BASELINE.start, value: 999 }]
  const result = score(rows)
  assert.deepEqual(ids(result), ['duplicate-observation'])
  assert.equal(result.findings[0].severity, 'error')
  assert.equal(statusFor(result.findings), 'incomplete')
  assert.equal(result.counts.scored, 0)
  assert.equal(result.counts.inconclusive, 1)
})

test('a steady page and a rising page produce nothing at all', () => {
  const steady = score(pageRows('/guides/steady', 40, 40))
  assert.deepEqual(steady.findings, [])
  assert.equal(statusFor(steady.findings), 'pass')
  assert.equal(steady.counts.scored, 1)

  const rising = score(pageRows('/guides/rising', 40, 90))
  assert.deepEqual(rising.findings, [])
  assert.equal(statusFor(rising.findings), 'pass')
})

test('the two decline thresholds are distinct and both are honoured', () => {
  const nearly = score(pageRows('/guides/upgrade', 100, 88))
  assert.deepEqual(ids(nearly), ['decline-near-threshold'])
  assert.equal(nearly.findings[0].severity, 'warning')
  assert.equal(statusFor(nearly.findings), 'pass', 'a warning alone completes the run')

  const past = score(pageRows('/guides/upgrade', 100, 70))
  assert.deepEqual(ids(past), ['decline-over-threshold'], 'the boundary is inclusive')

  const fine = score(pageRows('/guides/upgrade', 100, 91))
  assert.deepEqual(ids(fine), [])
})

test('seasonality exclusions remove the same days from both windows', () => {
  const spike = (index) => (index >= 13 && index <= 15 ? 1000 : 10)
  const rows = [
    ...rowsFor('/guides/seasonal', BASELINE.start, 30, spike),
    ...rowsFor('/guides/seasonal', RECENT.start, 30, (index) => (index >= 13 && index <= 15 ? 0 : 10)),
  ]
  const withSpike = score(rows)
  assert.deepEqual(ids(withSpike), ['decline-over-threshold'], 'the unexcluded spike dominates the comparison')

  const period = { kind: 'recurring', startKey: 914, endKey: 916 }
  const excluded = score(rows, {
    windows: {
      baseline: buildWindow(day(BASELINE.start), day(BASELINE.end), [period]),
      recent: buildWindow(day(RECENT.start), day(RECENT.end), [period]),
    },
  })
  assert.deepEqual(ids(excluded), [], 'excluding the same three days from both windows leaves a flat comparison')
})

test('freshness records add context and never a verdict', () => {
  const freshness = new Map([
    ['/guides/install', { file: 'exports/freshness.json', index: 0, page: '/guides/install', lastModifiedDay: day('2020-01-01'), inboundLinks: { baseline: 80, recent: 20 } }],
    ['/removed/page', { file: 'exports/freshness.json', index: 1, page: '/removed/page', lastModifiedDay: day('2025-08-01'), inboundLinks: null }],
  ])
  const result = score(pageRows('/guides/install', 40, 40), { freshness })
  // scorePages emits in page order; buildReport is what sorts the report.
  assert.deepEqual(ids(result), ['stale-content', 'inbound-link-decline', 'freshness-page-unknown'])
  assert.equal(
    statusFor(result.findings),
    'pass',
    'stale content and lost links are context; neither fails a run on its own',
  )
  assert.equal(result.counts.scored, 1)
})

test('an inbound link decline under the minimum link count is not reported', () => {
  const small = new Map([
    ['/guides/install', { file: 'f.json', index: 0, page: '/guides/install', lastModifiedDay: null, inboundLinks: { baseline: 4, recent: 0 } }],
  ])
  assert.deepEqual(ids(score(pageRows('/guides/install', 40, 40), { freshness: small })), [])
})

test('staleness is measured against the configured window, not the wall clock', () => {
  const record = (iso) => new Map([
    ['/p', { file: 'f.json', index: 0, page: '/p', lastModifiedDay: day(iso), inboundLinks: null }],
  ])
  const rows = pageRows('/p', 40, 40)
  assert.deepEqual(ids(score(rows, { freshness: record('2024-01-01') })), ['stale-content'])
  assert.deepEqual(ids(score(rows, { freshness: record('2024-05-01') })), [], '517 days before the window end is inside the bound')
})

test('output does not depend on the order rows arrive in', () => {
  const rows = [...pageRows('/b', 100, 40), ...pageRows('/a', 100, 88), ...pageRows('/c', 100, 100)]
  const forward = score(rows)
  const backward = score([...rows].reverse())
  assert.deepEqual(
    forward.findings.map((finding) => finding.message),
    backward.findings.map((finding) => finding.message),
  )
  assert.deepEqual(forward.counts, backward.counts)
  assert.deepEqual(
    ids(forward),
    ['decline-near-threshold', 'decline-over-threshold'],
    'pages are visited in code-unit order, so /a is reported before /b',
  )
})

test('decimals are rendered without locale formatting', () => {
  assert.equal(num(1234.56789), '1234.5679')
  assert.equal(num(1000000), '1000000')
  assert.equal(num(0.5), '0.5')
})
