/**
 * Every rule in the catalog, driven through the real CLI.
 *
 * The severity table, the documented table and the hand-written table in
 * `test/rules.test.mjs` are three declarations of the same thing, and three
 * declarations can be edited together. This file asserts none of them. For
 * every rule in the catalog it builds a real project, runs
 * `bin/content-decay-detector.mjs` as a process, and checks the observable
 * result: the rule the report names, the `severity` field it carries, the
 * `status` it derives, the summary counts, and the exit code the process
 * actually returned.
 *
 * Every expectation below is written out by hand. Downgrading a rule in
 * `RULE_SEVERITY` changes the emitted `severity` and the summary counts;
 * dropping it from `EVIDENCE_MISSING_RULES` changes the status and the exit
 * code. Neither can be hidden by editing another declaration.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { RULE_IDS, byCodeUnit } from '../src/index.mjs'
import {
  BASELINE,
  configJson,
  makeProject,
  pageRows,
  project,
  removeProject,
  rowsFor,
  runCli,
  seriesJson,
} from './helpers.mjs'

/** The summary key each severity is counted under. Written out, not derived. */
const COUNT_KEY = { error: 'errors', warning: 'warnings', info: 'info' }

const HEALTHY = () => pageRows('/guides/install', 40, 40)

const CASES = [
  {
    ruleId: 'decline-near-threshold',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    // 90 against 100 is exactly thresholds.warnRatio, and that boundary is
    // inclusive: at the ratio the page is reported.
    fixture: (t) => project(t, {
      rows: pageRows('/guides/upgrade', 100, 90),
      config: { thresholds: { decayRatio: 0.7, warnRatio: 0.9 } },
    }),
  },
  {
    ruleId: 'decline-over-threshold',
    severity: 'error',
    status: 'fail',
    exit: 1,
    fixture: (t) => project(t, { rows: pageRows('/guides/install', 60, 20) }),
  },
  {
    ruleId: 'duplicate-observation',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: [...pageRows('/guides/install', 40, 38), { page: '/guides/install', date: BASELINE.start, value: 999 }],
    }),
  },
  {
    ruleId: 'freshness-duplicate-page',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [
        { page: '/guides/install', lastModified: '2025-08-01' },
        { page: '/guides/install', lastModified: '2020-08-01' },
      ],
    }),
  },
  {
    ruleId: 'freshness-not-utf8',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [],
      files: { 'exports/freshness.json': Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]) },
    }),
  },
  {
    ruleId: 'freshness-page-unknown',
    severity: 'info',
    status: 'pass',
    exit: 0,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [{ page: '/gone', lastModified: '2025-08-01' }],
    }),
  },
  {
    ruleId: 'freshness-record-invalid',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [{ page: '/guides/install', lastModifed: '2025-01-02' }],
    }),
  },
  {
    ruleId: 'freshness-record-limit-exceeded',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [{ page: '/guides/install', lastModified: '2025-08-01' }, { page: '/b', lastModified: '2025-08-01' }],
      config: { limits: { maxFreshnessRecords: 1 } },
    }),
  },
  {
    ruleId: 'freshness-too-large',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [{ page: '/guides/install', lastModified: '2025-08-01' }],
      config: { limits: { maxFreshnessBytes: 16 } },
    }),
  },
  {
    ruleId: 'freshness-unparsable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [],
      files: { 'exports/freshness.json': 'nope\n' },
    }),
  },
  {
    ruleId: 'freshness-unreadable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, { rows: HEALTHY(), config: { freshness: ['exports/freshness.json'] } }),
  },
  {
    ruleId: 'inbound-link-decline',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [{ page: '/guides/install', inboundLinks: { baseline: 40, recent: 2 } }],
    }),
  },
  {
    ruleId: 'insufficient-coverage',
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: [...rowsFor('/guides/install', BASELINE.start, 10, 100), ...rowsFor('/guides/install', '2025-09-01', 10, 100)],
    }),
  },
  {
    ruleId: 'insufficient-volume',
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: [...rowsFor('/blog/old', BASELINE.start, 4, 5), ...rowsFor('/blog/old', '2025-09-01', 4, 1)],
    }),
  },
  {
    ruleId: 'metric-mismatch',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, { rows: [], files: { 'exports/analytics.json': seriesJson({ metric: 'users' }) } }),
  },
  {
    ruleId: 'no-pages-scored',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, { rows: rowsFor('/guides/install', '2023-01-01', 10, 50) }),
  },
  {
    ruleId: 'page-limit-exceeded',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: [...pageRows('/a', 60, 20), ...pageRows('/b', 60, 20)],
      config: { limits: { maxPages: 1 } },
    }),
  },
  {
    ruleId: 'row-invalid',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, { rows: [...HEALTHY(), { page: '/b', date: 'not-a-date', value: 1 }] }),
  },
  {
    ruleId: 'row-limit-exceeded',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, { rows: HEALTHY(), config: { limits: { maxRows: 5 } } }),
  },
  {
    ruleId: 'series-not-utf8',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: [],
      files: { 'exports/analytics.json': Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]) },
    }),
  },
  {
    ruleId: 'series-too-large',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, { rows: HEALTHY(), config: { limits: { maxSeriesBytes: 32 } } }),
  },
  {
    ruleId: 'series-unparsable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, { rows: [], files: { 'exports/analytics.json': 'nope\n' } }),
  },
  {
    ruleId: 'series-unreadable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    fixture: async (t) => {
      const root = await makeProject({ 'decay.config.json': configJson() })
      t.after(() => removeProject(root))
      return { root, config: join(root, 'decay.config.json') }
    },
  },
  {
    ruleId: 'stale-content',
    severity: 'info',
    status: 'pass',
    exit: 0,
    fixture: (t) => project(t, {
      rows: HEALTHY(),
      freshness: [{ page: '/guides/install', lastModified: '2019-01-01' }],
    }),
  },
  {
    ruleId: 'window-coverage-mismatch',
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    fixture: (t) => project(t, {
      rows: [...rowsFor('/guides/install', BASELINE.start, 30, 40), ...rowsFor('/guides/install', '2025-09-01', 22, 40)],
    }),
  },
]

test('every rule in the catalog has a fixture that reaches it through the CLI', () => {
  assert.deepEqual(
    CASES.map((entry) => entry.ruleId).sort(byCodeUnit),
    [...RULE_IDS],
    'a rule was added or renamed without a behavioural fixture pinning what it does to a run',
  )
})

for (const entry of CASES) {
  test(`${entry.ruleId} is ${entry.severity}, leaves the run ${entry.status}, and exits ${entry.exit}`, async (t) => {
    const site = await entry.fixture(t)
    const run = await runCli(['--config', site.config, '--json'])
    const report = JSON.parse(run.stdout)

    assert.deepEqual(
      report.findings.map((finding) => finding.ruleId),
      [entry.ruleId],
      'the fixture must reach this rule and nothing else, so the assertions below are about it alone',
    )
    assert.equal(report.findings[0].severity, entry.severity, 'the emitted severity')
    assert.equal(report.status, entry.status, 'the status the report derived')
    assert.equal(run.code, entry.exit, 'the exit code the process returned')

    for (const [severity, key] of Object.entries(COUNT_KEY)) {
      assert.equal(
        report.summary[key],
        severity === entry.severity ? 1 : 0,
        `summary.${key} after one ${entry.ruleId}`,
      )
    }
  })
}
