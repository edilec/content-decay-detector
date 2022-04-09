/**
 * Exactly at a documented limit is accepted; one past it is refused.
 *
 * Every bound in this tool is written as `<` or `>`, and tightening one to
 * `<=` or `>=` refuses input the documentation promises to accept -- a
 * legitimate page reported as unreadable, a legitimate configuration refused
 * outright. Tests that only exercise the over-the-limit side cannot see that:
 * they pass either way. Each case below pins both sides of one boundary.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import {
  MAX_EXCLUDE_PERIODS,
  MAX_INPUT_FILES,
  MAX_METRIC_LENGTH,
  MAX_PAGE_ID_LENGTH,
  ConfigError,
  checkProject,
  exitCodeFor,
} from '../src/index.mjs'
import {
  BASELINE,
  RECENT,
  configJson,
  freshnessJson,
  makeProject,
  pageRows,
  project,
  removeProject,
  rowsFor,
  ruleIdsOf,
  seriesJson,
} from './helpers.mjs'

const failed = (promise) => promise.then(() => null, (error) => error)

/** A project whose analytics export is written verbatim, so its size is known. */
async function sized(t, files, config) {
  const root = await makeProject({ 'decay.config.json': configJson(config), ...files })
  t.after(() => removeProject(root))
  return join(root, 'decay.config.json')
}

async function passes(config, what) {
  const report = await checkProject({ config })
  assert.deepEqual(ruleIdsOf(report), [], what)
  assert.equal(report.status, 'pass', what)
  assert.equal(exitCodeFor(report), 0, what)
  return report
}

test('a baseline total exactly at minimumVolume is scored', async (t) => {
  const rows = pageRows('/a', 10, 10)
  const at = await project(t, { rows, config: { minimumVolume: 300 } })
  assert.equal((await passes(at.config, 'a total of 300 at a minimum of 300')).summary.scored, 1)

  const over = await project(t, { rows, config: { minimumVolume: 301 } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over.config })), ['insufficient-volume'])
})

test('a window with exactly minimumDays of data is scored', async (t) => {
  const rows = [
    ...rowsFor('/a', BASELINE.start, 20, 20),
    ...rowsFor('/a', RECENT.start, 20, 20),
  ]
  const at = await project(t, { rows, config: { minimumDays: 20, maxCoverageGapDays: 0 } })
  assert.equal((await passes(at.config, '20 days at a minimum of 20')).summary.scored, 1)

  const over = await project(t, { rows, config: { minimumDays: 21, maxCoverageGapDays: 0 } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over.config })), ['insufficient-coverage'])
})

test('minimumDays exactly equal to the days a window keeps is allowed', async (t) => {
  // One more than this and no page could ever be scored, which is refused.
  const at = await project(t, { rows: pageRows('/a', 40, 40), config: { minimumDays: 30 } })
  assert.equal((await passes(at.config, 'minimumDays 30 against 30 included days')).summary.scored, 1)

  const over = await project(t, { rows: pageRows('/a', 40, 40), config: { minimumDays: 31 } })
  assert.match((await failed(checkProject({ config: over.config }))).message, /no page could ever be scored/u)
})

test('a coverage gap exactly at maxCoverageGapDays is compared', async (t) => {
  const rows = [
    ...rowsFor('/a', BASELINE.start, 30, 40),
    ...rowsFor('/a', RECENT.start, 28, 40),
  ]
  const at = await project(t, { rows, config: { maxCoverageGapDays: 2 } })
  assert.equal((await passes(at.config, 'a gap of 2 at a maximum of 2')).summary.scored, 1)

  const over = await project(t, { rows, config: { maxCoverageGapDays: 1 } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over.config })), ['window-coverage-mismatch'])
})

test('a page exactly at stalenessDays is not called stale', async (t) => {
  // 2024-09-30 is 365 days before the end of the recent window.
  const rows = pageRows('/a', 40, 40)
  const freshness = [{ page: '/a', lastModified: '2024-09-30' }]
  const at = await project(t, { rows, freshness, config: { stalenessDays: 365 } })
  await passes(at.config, 'an age of 365 at a bound of 365')

  const over = await project(t, { rows, freshness, config: { stalenessDays: 364 } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over.config })), ['stale-content'])
})

test('an inbound link count exactly at thresholds.minimumLinks is considered', async (t) => {
  const rows = pageRows('/a', 40, 40)
  const freshness = [{ page: '/a', inboundLinks: { baseline: 10, recent: 0 } }]
  const at = await project(t, { rows, freshness, config: { thresholds: { minimumLinks: 10 } } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: at.config })), ['inbound-link-decline'])

  const under = await project(t, { rows, freshness, config: { thresholds: { minimumLinks: 11 } } })
  await passes(under.config, 'nine fewer links than the minimum is not considered')
})

test('an inbound link ratio exactly at thresholds.linkRatio is reported', async (t) => {
  const rows = pageRows('/a', 40, 40)
  const thresholds = { linkRatio: 0.5, minimumLinks: 10 }
  const at = await project(t, {
    rows,
    freshness: [{ page: '/a', inboundLinks: { baseline: 20, recent: 10 } }],
    config: { thresholds },
  })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: at.config })), ['inbound-link-decline'])

  const over = await project(t, {
    rows,
    freshness: [{ page: '/a', inboundLinks: { baseline: 20, recent: 11 } }],
    config: { thresholds },
  })
  await passes(over.config, 'one link above the ratio is not reported')
})

test('a decline exactly at each threshold ratio is reported', async (t) => {
  // Both boundaries are documented as "at or under", and both are inclusive.
  const thresholds = { decayRatio: 0.7, warnRatio: 0.9 }
  const warn = await project(t, { rows: pageRows('/a', 100, 90), config: { thresholds } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: warn.config })), ['decline-near-threshold'])

  const decay = await project(t, { rows: pageRows('/a', 100, 70), config: { thresholds } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: decay.config })), ['decline-over-threshold'])

  const fine = await project(t, { rows: pageRows('/a', 1000, 901), config: { thresholds } })
  await passes(fine.config, 'a ratio of 0.901 is above the warn boundary')
})

test('an export of exactly maxSeriesBytes is read', async (t) => {
  const analytics = seriesJson({ rows: pageRows('/a', 40, 40) })
  const size = Buffer.byteLength(analytics)
  const at = await sized(t, { 'exports/analytics.json': analytics }, { limits: { maxSeriesBytes: size } })
  assert.equal((await passes(at, `${size} bytes at a limit of ${size}`)).summary.scored, 1)

  const over = await sized(t, { 'exports/analytics.json': analytics }, { limits: { maxSeriesBytes: size - 1 } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over })), ['series-too-large'])
})

test('a freshness export of exactly maxFreshnessBytes is read', async (t) => {
  const analytics = seriesJson({ rows: pageRows('/a', 40, 40) })
  const freshness = freshnessJson([{ page: '/a', lastModified: '2025-09-01' }])
  const size = Buffer.byteLength(freshness)
  const files = { 'exports/analytics.json': analytics, 'exports/freshness.json': freshness }

  const at = await sized(t, files, {
    freshness: ['exports/freshness.json'],
    limits: { maxFreshnessBytes: size },
  })
  await passes(at, `${size} bytes at a limit of ${size}`)

  const over = await sized(t, files, {
    freshness: ['exports/freshness.json'],
    limits: { maxFreshnessBytes: size - 1 },
  })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over })), ['freshness-too-large'])
})

test('exactly maxPages pages are scored', async (t) => {
  const rows = [...pageRows('/a', 40, 40), ...pageRows('/b', 40, 40)]
  const at = await project(t, { rows, config: { limits: { maxPages: 2 } } })
  assert.equal((await passes(at.config, 'two pages at a limit of two')).summary.scored, 2)

  const over = await project(t, { rows, config: { limits: { maxPages: 1 } } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over.config })), ['page-limit-exceeded'])
})

test('exactly maxRows rows are read', async (t) => {
  const rows = pageRows('/a', 40, 40)
  assert.equal(rows.length, 60)
  const at = await project(t, { rows, config: { limits: { maxRows: 60 } } })
  assert.equal((await passes(at.config, '60 rows at a limit of 60')).summary.observations, 60)

  const over = await project(t, { rows, config: { limits: { maxRows: 59 } } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over.config })), ['row-limit-exceeded'])
})

test('exactly maxFreshnessRecords records are read', async (t) => {
  const rows = pageRows('/a', 40, 40)
  const freshness = [{ page: '/a', lastModified: '2025-09-01' }, { page: '/a2', lastModified: '2025-09-01' }]
  const at = await project(t, { rows, freshness, config: { limits: { maxFreshnessRecords: 2 } } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: at.config })), ['freshness-page-unknown'])

  const over = await project(t, { rows, freshness, config: { limits: { maxFreshnessRecords: 1 } } })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: over.config })), ['freshness-record-limit-exceeded'])
})

test('a window of exactly maxWindowDays is allowed', async (t) => {
  const at = await project(t, { rows: pageRows('/a', 40, 40), config: { limits: { maxWindowDays: 30 } } })
  assert.equal((await passes(at.config, 'a 30-day window at a limit of 30')).summary.scored, 1)

  const over = await project(t, { rows: pageRows('/a', 40, 40), config: { limits: { maxWindowDays: 29 } } })
  const error = await failed(checkProject({ config: over.config }))
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /spans 30 days, over limits.maxWindowDays of 29/u)
})

test('a page id of exactly MAX_PAGE_ID_LENGTH characters is read', async (t) => {
  const id = `/${'x'.repeat(MAX_PAGE_ID_LENGTH - 1)}`
  assert.equal(id.length, MAX_PAGE_ID_LENGTH)
  const at = await project(t, {
    rows: pageRows(id, 40, 40),
    freshness: [{ page: id, lastModified: '2025-09-01' }],
  })
  assert.equal((await passes(at.config, '256 characters at a bound of 256')).summary.scored, 1)

  const longer = `${id}x`
  const over = await project(t, {
    rows: pageRows(longer, 40, 40),
    freshness: [{ page: longer, lastModified: '2025-09-01' }],
  })
  const report = await checkProject({ config: over.config })
  assert.equal(ruleIdsOf(report).includes('row-invalid'), true)
  assert.equal(ruleIdsOf(report).includes('freshness-record-invalid'), true)
})

test('exactly MAX_INPUT_FILES paths are accepted in series and in freshness', async (t) => {
  const many = (count) => Array.from({ length: count }, (unused, index) => `exports/absent-${index}.json`)

  const series = await project(t, { rows: [], config: { series: many(MAX_INPUT_FILES) } })
  const seriesReport = await checkProject({ config: series.config })
  assert.equal(seriesReport.findings.length, MAX_INPUT_FILES, '64 declared paths are all read')
  assert.equal(seriesReport.status, 'incomplete')

  const freshness = await project(t, {
    rows: pageRows('/a', 40, 40),
    config: { freshness: many(MAX_INPUT_FILES) },
  })
  assert.equal((await checkProject({ config: freshness.config })).findings.length, MAX_INPUT_FILES)

  for (const label of ['series', 'freshness']) {
    const over = await project(t, { rows: [], config: { [label]: many(MAX_INPUT_FILES + 1) } })
    const error = await failed(checkProject({ config: over.config }))
    assert.equal(error instanceof ConfigError, true, label)
    assert.match(error.message, /names 65 files, over the bound of 64/u, label)
  }
})

test('exactly MAX_EXCLUDE_PERIODS exclusion periods are accepted', async (t) => {
  const periods = (count) => Array.from({ length: count }, () => ({ start: '01-01', end: '01-02' }))
  const seasonality = (count) => ({ rule: 'year-over-year', excludePeriods: periods(count) })

  const at = await project(t, {
    rows: pageRows('/a', 40, 40),
    config: { seasonality: seasonality(MAX_EXCLUDE_PERIODS) },
  })
  await passes(at.config, '64 periods at a bound of 64')

  const over = await project(t, {
    rows: pageRows('/a', 40, 40),
    config: { seasonality: seasonality(MAX_EXCLUDE_PERIODS + 1) },
  })
  assert.match((await failed(checkProject({ config: over.config }))).message, /65 periods, over the bound of 64/u)
})

test('a metric of exactly MAX_METRIC_LENGTH characters is accepted', async (t) => {
  const metric = 'm'.repeat(MAX_METRIC_LENGTH)
  const at = await sized(
    t,
    { 'exports/analytics.json': seriesJson({ metric, rows: pageRows('/a', 40, 40) }) },
    { metric },
  )
  await passes(at, '64 characters at a bound of 64')

  const over = await project(t, { rows: [], config: { metric: `${metric}m` } })
  assert.match((await failed(checkProject({ config: over.config }))).message, /at most 64 characters/u)
})

test('a threshold ratio of exactly 1 is accepted, and equal thresholds are allowed', async (t) => {
  const site = await project(t, {
    rows: pageRows('/a', 40, 40),
    config: { thresholds: { decayRatio: 1, warnRatio: 1 } },
  })
  // Every scored page is at or under a ratio of 1, so this reports the page
  // rather than refusing the configuration.
  assert.deepEqual(ruleIdsOf(await checkProject({ config: site.config })), ['decline-over-threshold'])

  const over = await project(t, { rows: [], config: { thresholds: { warnRatio: 1.0000001 } } })
  assert.match((await failed(checkProject({ config: over.config }))).message, /at most 1/u)
})

test('a maxCoverageGapDays of exactly 0 is accepted', async (t) => {
  const site = await project(t, { rows: pageRows('/a', 40, 40), config: { maxCoverageGapDays: 0 } })
  await passes(site.config, 'a gap bound of zero demands identical coverage, which this has')

  const under = await project(t, { rows: pageRows('/a', 40, 40), config: { maxCoverageGapDays: -1 } })
  assert.match((await failed(checkProject({ config: under.config }))).message, /integer of 0 or more/u)
})
