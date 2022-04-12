import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import {
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  DISCLAIMER,
  MAX_CONFIG_BYTES,
  REPORT_SCHEMA_VERSION,
  TOOL_ID,
  checkProject,
  exitCodeFor,
  formatSummary,
  renderReport,
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

test('a healthy project passes and carries the full envelope', async (t) => {
  const site = await project(t, { rows: pageRows('/guides/install', 40, 41) })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
  assert.equal(report.tool, TOOL_ID)
  assert.equal(report.disclaimer, DISCLAIMER)
  assert.deepEqual(report.summary, {
    checked: 1, errors: 0, warnings: 0, info: 0, scored: 1, inconclusive: 0, declining: 0, observations: 60,
  })
  assert.equal(exitCodeFor(report), 0)
})

test('a falling page with enough volume fails the run', async (t) => {
  const site = await project(t, { rows: pageRows('/guides/install', 60, 20) })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['decline-over-threshold'])
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.equal(report.summary.declining, 1)
})

test('a sparse page leaves the run incomplete rather than green', async (t) => {
  const site = await project(t, {
    rows: [...rowsFor('/blog/old', BASELINE.start, 4, 5), ...rowsFor('/blog/old', RECENT.start, 4, 1)],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['insufficient-volume'])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.summary.errors, 0, 'nothing here is an error, so only the evidence marking blocks a pass')
  assert.equal(report.summary.scored, 0)
  assert.equal(report.summary.inconclusive, 1)
})

test('the minimum volume can be overridden, and doing so changes the verdict', async (t) => {
  const site = await project(t, {
    rows: [...rowsFor('/blog/old', BASELINE.start, 24, 5), ...rowsFor('/blog/old', RECENT.start, 24, 1)],
  })
  assert.equal((await checkProject({ config: site.config })).status, 'incomplete')
  const lowered = await checkProject({ config: site.config, minimumVolume: 100 })
  assert.deepEqual(ruleIdsOf(lowered), ['decline-over-threshold'])
  assert.equal(lowered.status, 'fail')
  const raised = await checkProject({ config: site.config, minimumVolume: 100000 })
  assert.equal(raised.status, 'incomplete')
})

test('a run that scored nothing is incomplete, never a vacuous pass', async (t) => {
  // Readable rows, all outside both windows. Nothing failed to load, so only
  // the vacuous-pass guard stands between this and `pass` with `scored: 0`.
  const site = await project(t, { rows: rowsFor('/guides/install', '2023-01-01', 10, 50) })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['no-pages-scored'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.scored, 0)
  assert.equal(exitCodeFor(report), 2)
})

test('a page whose rows all fall outside both windows is invisible', async (t) => {
  // One of the documented ways an unflagged page can still be unhealthy: the
  // comparison is about the two windows, so rows outside them are not part of
  // it. The page is not counted, not reported, and does not stop the pass --
  // even though its numbers collapsed between the two months it does cover.
  const site = await project(t, {
    rows: [
      ...pageRows('/guides/install', 40, 41),
      ...rowsFor('/collapsed-outside-the-windows', '2023-01-01', 30, 900),
      ...rowsFor('/collapsed-outside-the-windows', '2023-06-01', 30, 1),
    ],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
  assert.equal(report.summary.checked, 1, 'only the page with rows inside the windows is counted')
  assert.equal(report.summary.observations, 60)
  assert.equal(
    renderReport(report).includes('collapsed-outside-the-windows'),
    false,
    'the page appears nowhere in the report',
  )
})

test('the vacuous-pass guard does not double up on another explanation', async (t) => {
  const site = await project(t, { rows: [], files: { 'exports/analytics.json': seriesJson({ metric: 'users' }) } })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['metric-mismatch'])
  assert.equal(report.status, 'incomplete')
})

test('an unknown configuration key is refused', async (t) => {
  const root = await makeProject({
    'decay.config.json': `${JSON.stringify({ ...JSON.parse(configJson()), minimumVolumes: 10 }, null, 2)}\n`,
    'exports/analytics.json': seriesJson({ rows: pageRows('/a', 60, 20) }),
  })
  t.after(() => removeProject(root))
  const error = await failed(checkProject({ config: join(root, 'decay.config.json') }))
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /Unknown key "minimumVolumes"/u)
})

test('a one-character typo in a limit name cannot turn a failure green', async (t) => {
  const site = await project(t, { rows: pageRows('/a', 60, 20), config: { limits: { maxRow: 1 } } })
  const error = await failed(checkProject({ config: site.config }))
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /Unknown limit "maxRow"/u)
  assert.match(error.message, /maxRows/u, 'the refusal names the limits that do exist')
})

test('every configurable limit is enforced, and exceeding one is never silent', async (t) => {
  const rows = pageRows('/a', 60, 20)
  const cases = [
    [{ maxRows: 5 }, 'row-limit-exceeded'],
    [{ maxSeriesBytes: 32 }, 'series-too-large'],
    [{ maxPages: 0 + 1 }, null],
  ]
  for (const [limits, expected] of cases.slice(0, 2)) {
    const site = await project(t, { rows, config: { limits } })
    const report = await checkProject({ config: site.config })
    assert.deepEqual(ruleIdsOf(report), [expected], JSON.stringify(limits))
    assert.equal(report.status, 'incomplete', JSON.stringify(limits))
    assert.equal(report.summary.scored, 0)
  }

  const manyPages = [...pageRows('/a', 60, 20), ...pageRows('/b', 60, 20)]
  const site = await project(t, { rows: manyPages, config: { limits: { maxPages: 1 } } })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['page-limit-exceeded'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.scored, 0)
})

test('the freshness limits are enforced too', async (t) => {
  const rows = pageRows('/a', 40, 40)
  const freshness = [{ page: '/a', lastModified: '2025-08-01' }, { page: '/b', lastModified: '2025-08-01' }]

  const tooMany = await project(t, { rows, freshness, config: { limits: { maxFreshnessRecords: 1 } } })
  const first = await checkProject({ config: tooMany.config })
  assert.deepEqual(ruleIdsOf(first), ['freshness-record-limit-exceeded'])
  assert.equal(first.status, 'incomplete')

  const tooBig = await project(t, { rows, freshness, config: { limits: { maxFreshnessBytes: 16 } } })
  const second = await checkProject({ config: tooBig.config })
  assert.deepEqual(ruleIdsOf(second), ['freshness-too-large'])
  assert.equal(second.status, 'incomplete')
})

test('the window-length limit bounds the configuration and refuses the run', async (t) => {
  const site = await project(t, {
    rows: [],
    config: {
      baseline: { start: '2023-01-01', end: '2023-12-31' },
      recent: { start: '2024-01-01', end: '2024-12-31' },
      seasonality: { rule: 'none' },
      limits: { maxWindowDays: 30 },
    },
  })
  const error = await failed(checkProject({ config: site.config }))
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /over limits.maxWindowDays of 30/u)
})

test('two windows that cannot be compared are refused before anything is read', async (t) => {
  const site = await project(t, {
    rows: pageRows('/a', 60, 20),
    config: { recent: { start: '2025-09-01', end: '2025-09-20' } },
  })
  const error = await failed(checkProject({ config: site.config }))
  assert.equal(error instanceof ConfigError, true)
  assert.equal(error.rule, 'windows-not-comparable')
  assert.match(error.message, /different length/u)
})

test('the year-over-year rule is enforced by the configuration layer', async (t) => {
  const site = await project(t, {
    rows: pageRows('/a', 40, 40),
    config: { recent: { start: '2025-10-01', end: '2025-10-30' } },
  })
  const error = await failed(checkProject({ config: site.config }))
  assert.equal(error.rule, 'windows-not-comparable')
  assert.match(error.message, /same month and day/u)

  const relaxed = await project(t, {
    rows: pageRows('/a', 40, 40),
    config: { recent: { start: '2025-10-01', end: '2025-10-30' }, seasonality: { rule: 'none' } },
  })
  assert.equal((await checkProject({ config: relaxed.config })).status, 'incomplete', 'no rows fall in the shifted window')
})

test('threshold and policy values are validated', async (t) => {
  const cases = [
    [{ thresholds: { decayRatio: 0 } }, /thresholds.decayRatio/u],
    [{ thresholds: { warnRatio: 1.5 } }, /thresholds.warnRatio/u],
    [{ thresholds: { decayRatio: 0.95, warnRatio: 0.9 } }, /at most thresholds.warnRatio/u],
    [{ thresholds: { minimumLinks: 0 } }, /thresholds.minimumLinks/u],
    [{ thresholds: { linkRation: 0.5 } }, /Unknown key "linkRation"/u],
    [{ minimumVolume: 0 }, /minimumVolume/u],
    [{ minimumDays: 0 }, /minimumDays/u],
    [{ minimumDays: 31 }, /no page could ever be scored/u],
    [{ maxCoverageGapDays: -1 }, /maxCoverageGapDays/u],
    [{ stalenessDays: 1.5 }, /stalenessDays/u],
    [{ metric: '' }, /metric must name/u],
    [{ metric: 'm'.repeat(65) }, /at most 64 characters/u],
    [{ series: [] }, /at least one export file/u],
    [{ series: Array.from({ length: 65 }, () => 'exports/analytics.json') }, /over the bound of 64/u],
    [{ seasonality: { rule: 'quarterly' } }, /seasonality.rule must be one of/u],
    [{ seasonality: { excludePeriods: [{ start: '09-16', end: '09-14' }] }, }, /is before/u],
    [{ seasonality: { excludePeriods: [{ start: '2025-09-01', end: '09-14' }] } }, /spell both bounds the same way/u],
    [{ seasonality: { excludePeriods: Array.from({ length: 65 }, () => ({ start: '09-14', end: '09-16' })) } }, /over the bound of 64/u],
    [{ baseline: { start: '2024-09-30', end: '2024-09-01' } }, /baseline.end is before/u],
    [{ baseline: { start: '2024-09-01' } }, /baseline.end must be/u],
  ]
  for (const [overrides, pattern] of cases) {
    const site = await project(t, { rows: pageRows('/a', 40, 40), config: overrides })
    const error = await failed(checkProject({ config: site.config }))
    assert.equal(error instanceof ConfigError, true, JSON.stringify(overrides))
    assert.match(error.message, pattern, JSON.stringify(overrides))
  }
})

test('the configuration file is decoded strictly, like every other input', async (t) => {
  const root = await makeProject({
    'decay.config.json': Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]),
    'exports/analytics.json': seriesJson({ rows: pageRows('/a', 60, 20) }),
  })
  t.after(() => removeProject(root))
  const error = await failed(checkProject({ config: join(root, 'decay.config.json') }))
  assert.equal(error instanceof ConfigError, true)
  assert.match(error.message, /not valid UTF-8/u)
})

test('a configuration that is not JSON, absent, or oversized is refused', async (t) => {
  const root = await makeProject({
    'bad.json': '{ nope',
    'big.json': `{"padding":"${'x'.repeat(MAX_CONFIG_BYTES)}"}`,
    'exports/analytics.json': seriesJson({ rows: [] }),
  })
  t.after(() => removeProject(root))
  assert.match((await failed(checkProject({ config: join(root, 'bad.json') }))).message, /not valid JSON/u)
  assert.match((await failed(checkProject({ config: join(root, 'absent.json') }))).message, /Could not load the config/u)
  assert.match((await failed(checkProject({ config: join(root, 'big.json') }))).message, /byte limit/u)
  assert.match((await failed(checkProject({ config: root }))).message, /not a regular file/u)
})

test('an export that could not be read reports which one, and stays incomplete', async (t) => {
  const root = await makeProject({ 'decay.config.json': configJson() })
  t.after(() => removeProject(root))
  const report = await checkProject({ config: join(root, 'decay.config.json') })
  assert.deepEqual(ruleIdsOf(report), ['series-unreadable'])
  assert.equal(report.findings[0].location.file, 'exports/analytics.json')
  assert.equal(report.status, 'incomplete')
})

test('an export whose bytes are not UTF-8 is never decoded leniently', async (t) => {
  const site = await project(t, {
    rows: [],
    files: { 'exports/analytics.json': Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]) },
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['series-not-utf8'])
  assert.equal(report.status, 'incomplete')
})

test('a document holding a literal replacement character is still valid UTF-8', async (t) => {
  // Encoding validity is decided by the bytes, never inferred from the text.
  const rows = pageRows('/a�/b', 40, 40)
  const site = await project(t, { rows })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a page described twice by the freshness exports is ambiguous', async (t) => {
  const site = await project(t, {
    rows: pageRows('/a', 40, 40),
    freshness: [{ page: '/a', lastModified: '2025-08-01' }, { page: '/a', lastModified: '2020-08-01' }],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['freshness-duplicate-page'])
  assert.equal(report.status, 'incomplete')
})

test('several analytics exports are merged, and each is named in its own findings', async (t) => {
  const root = await makeProject({
    'decay.config.json': configJson({ series: ['exports/a.json', 'exports/b.json'] }),
    'exports/a.json': seriesJson({ rows: pageRows('/a', 60, 20) }),
    'exports/b.json': seriesJson({ rows: [...pageRows('/b', 40, 40), { page: '/b', date: 'nope', value: 1 }] }),
  })
  t.after(() => removeProject(root))
  const report = await checkProject({ config: join(root, 'decay.config.json') })
  // A page-level finding carries no file, and an absent file sorts first.
  assert.deepEqual(ruleIdsOf(report), ['decline-over-threshold', 'row-invalid'])
  assert.equal(report.findings[0].location.file, undefined)
  assert.equal(report.findings[1].location.file, 'exports/b.json')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.status, 'incomplete', 'the unread row outranks the completed failure')
})

test('the report is byte-identical across runs', async (t) => {
  const site = await project(t, {
    rows: [...pageRows('/a', 60, 20), ...rowsFor('/b', BASELINE.start, 3, 2)],
    freshness: [{ page: '/a', lastModified: '2019-01-01', inboundLinks: { baseline: 40, recent: 2 } }],
  })
  const first = renderReport(await checkProject({ config: site.config }))
  const second = renderReport(await checkProject({ config: site.config }))
  assert.equal(first, second)
  assert.equal(JSON.parse(first).status, 'incomplete')
  assert.equal(first.endsWith('\n'), true)
})

test('the config schema version is pinned', async (t) => {
  assert.equal(CONFIG_SCHEMA_VERSION, '1')
  const site = await project(t, { rows: [], config: { schemaVersion: '2' } })
  const error = await failed(checkProject({ config: site.config }))
  assert.match(error.message, /Unsupported config schemaVersion: 2/u)
})

test('a freshness export naming an unknown page reports it without failing', async (t) => {
  const site = await project(t, {
    rows: pageRows('/a', 40, 40),
    freshness: [{ page: '/gone', lastModified: '2025-08-01' }],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['freshness-page-unknown'])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.info, 1)
})

test('the freshness export shape used in the fixtures round trips', () => {
  const written = freshnessJson([{ page: '/a', lastModified: '2025-01-01' }])
  assert.deepEqual(JSON.parse(written), { schemaVersion: '1', pages: [{ page: '/a', lastModified: '2025-01-01' }] })
})

test('a page is not called unknown when an analytics export was not read', async (t) => {
  // The tool would have to have read every row to know a page is absent from
  // them. One refused row is enough to make that claim unsupported, so it is
  // not made. Reporting evidence it never obtained is exactly the defect this
  // guard exists for.
  const withAllRows = await project(t, {
    rows: pageRows('/a', 40, 40),
    freshness: [{ page: '/gone', lastModified: '2025-08-01' }],
  })
  assert.deepEqual(ruleIdsOf(await checkProject({ config: withAllRows.config })), ['freshness-page-unknown'])

  const withARefusedRow = await project(t, {
    rows: [...pageRows('/a', 40, 40), { page: '/b', date: 'not-a-date', value: 1 }],
    freshness: [{ page: '/gone', lastModified: '2025-08-01' }],
  })
  const report = await checkProject({ config: withARefusedRow.config })
  assert.deepEqual(ruleIdsOf(report), ['row-invalid'], 'the unknown-page claim is withheld, not downgraded')
  assert.equal(report.status, 'incomplete')
})

test('a path with a control character cannot forge a line in the summary', async (t) => {
  // The export is never written, so the finding that names it is the one that
  // carries the path into both the report and the human summary.
  const forged = 'exports/a\nERROR   forged-rule                     everywhere.json'
  const root = await makeProject({ 'decay.config.json': configJson({ series: [forged] }) })
  t.after(() => removeProject(root))
  const report = await checkProject({ config: join(root, 'decay.config.json') })
  assert.deepEqual(ruleIdsOf(report), ['series-unreadable'])
  assert.equal(report.findings[0].location.file.includes('forged-rule'), true, 'the path is still reported')
  for (const finding of report.findings) {
    assert.equal((finding.location.file ?? '').includes('\n'), false, 'a newline survived into location.file')
  }
  const summary = formatSummary(report)
  const reported = summary.split('\n').filter((line) => /^(ERROR|WARNING|INFO)/u.test(line))
  assert.equal(reported.length, 1, 'exactly one finding was reported, so exactly one line is printed')
})

test('a freshness path with a control character is flattened too', async (t) => {
  const forged = 'exports/f\nERROR   forged-rule                     everywhere.json'
  const root = await makeProject({
    'decay.config.json': configJson({ freshness: [forged] }),
    'exports/analytics.json': seriesJson({ rows: pageRows('/a', 40, 40) }),
  })
  t.after(() => removeProject(root))
  const report = await checkProject({ config: join(root, 'decay.config.json') })
  assert.deepEqual(ruleIdsOf(report), ['freshness-unreadable'])
  assert.equal(report.findings[0].location.file.includes('forged-rule'), true, 'the path is still reported')
  assert.equal(report.findings[0].location.file.includes('\n'), false, 'a newline survived into location.file')
  const reported = formatSummary(report).split('\n').filter((line) => /^(ERROR|WARNING|INFO)/u.test(line))
  assert.equal(reported.length, 1)
})

test('the human summary sanitises what it prints, whatever it is handed', () => {
  // Defence in depth: findings are sanitised where they are built, and the
  // summary sanitises again, so a field added later that forgets the first
  // still cannot forge a line in somebody's terminal or CI log.
  const summary = formatSummary({
    status: 'fail',
    disclaimer: 'd',
    summary: { checked: 1, errors: 1, warnings: 0, info: 0, scored: 1, inconclusive: 0, declining: 1, observations: 1 },
    findings: [{
      ruleId: 'decline-over-threshold',
      severity: 'error',
      message: 'm',
      location: { file: 'a\nERROR   forged-rule    elsewhere', pointer: '/pages/x\nINFO    also-forged    elsewhere' },
    }],
  })
  const reported = summary.split('\n').filter((line) => /^(ERROR|WARNING|INFO)/u.test(line))
  assert.equal(reported.length, 1, 'one finding must print exactly one line')
  assert.equal(reported[0].includes('forged-rule'), true, 'the text is still shown, on the finding is own line')
  assert.equal(reported[0].includes('also-forged'), true)
})
