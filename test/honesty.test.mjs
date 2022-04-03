import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DISCLAIMER,
  EVIDENCE_MISSING_RULES,
  RULE_SEVERITY,
  checkProject,
  exitCodeFor,
  findCausalClaim,
  marksEvidenceMissing,
  renderReport,
  severityFor,
} from '../src/index.mjs'
import { BASELINE, RECENT, pageRows, project, rowsFor, ruleIdsOf } from './helpers.mjs'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))

async function sources() {
  const files = []
  for (const directory of [SRC, BIN_DIR]) {
    for (const name of await readdir(directory)) {
      files.push([join(directory, name), await readFile(join(directory, name), 'utf8')])
    }
  }
  assert.ok(files.length >= 7, 'the source scan found too few files to be scanning the right place')
  return files
}

/**
 * Rules that are evidence-missing and NOT error severity.
 *
 * For each of these, membership in `EVIDENCE_MISSING_RULES` is the only thing
 * preventing a green run. Every one has an end-to-end test below that fails if
 * that membership is removed.
 */
const WARNING_ONLY_EVIDENCE_RULES = ['insufficient-coverage', 'insufficient-volume', 'window-coverage-mismatch']

test('the set of rules whose only guard is the evidence marking is the documented set', () => {
  const actual = EVIDENCE_MISSING_RULES.filter((ruleId) => severityFor(ruleId) !== 'error')
  assert.deepEqual(
    [...actual],
    WARNING_ONLY_EVIDENCE_RULES,
    'a rule gained or lost the marking that is its only defence; give it an end-to-end test below',
  )
})

test('insufficient volume alone blocks a pass end to end', async (t) => {
  const site = await project(t, {
    rows: [...rowsFor('/blog/old', BASELINE.start, 4, 5), ...rowsFor('/blog/old', RECENT.start, 4, 1)],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['insufficient-volume'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('insufficient coverage alone blocks a pass end to end, in either window', async (t) => {
  // The gate is per window: too few days on *either* side is enough to refuse
  // the comparison. The two asymmetric shapes are 21 days against 19, a gap of
  // 2 that maxCoverageGapDays allows, so nothing but the per-window minimum
  // stops them, and each pins one half of the condition.
  const shapes = [
    ['both windows short', 10, 10],
    ['only the baseline window short', 19, 21],
    ['only the recent window short', 21, 19],
  ]
  for (const [what, baselineDays, recentDays] of shapes) {
    const site = await project(t, {
      rows: [
        ...rowsFor('/guides/a', BASELINE.start, baselineDays, 100),
        ...rowsFor('/guides/a', RECENT.start, recentDays, 100),
      ],
    })
    const report = await checkProject({ config: site.config })
    assert.deepEqual(ruleIdsOf(report), ['insufficient-coverage'], what)
    assert.equal(report.summary.errors, 0, what)
    assert.equal(report.summary.scored, 0, what)
    assert.equal(report.status, 'incomplete', what)
    assert.equal(exitCodeFor(report), 2, what)
  }
})

test('a coverage mismatch alone blocks a pass end to end', async (t) => {
  const site = await project(t, {
    rows: [...rowsFor('/guides/a', BASELINE.start, 30, 40), ...rowsFor('/guides/a', RECENT.start, 22, 40)],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['window-coverage-mismatch'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a run that scored nothing blocks a pass end to end', async (t) => {
  const site = await project(t, { rows: rowsFor('/guides/a', '2022-01-01', 10, 100) })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report), ['no-pages-scored'])
  assert.equal(report.summary.scored, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('every finding in a real run takes its severity from the frozen table', async (t) => {
  const site = await project(t, {
    rows: [
      ...pageRows('/guides/install', 60, 20),
      ...pageRows('/guides/upgrade', 100, 88),
      ...rowsFor('/blog/old', BASELINE.start, 4, 5),
    ],
    freshness: [
      { page: '/guides/install', lastModified: '2019-01-01', inboundLinks: { baseline: 80, recent: 10 } },
      { page: '/gone', lastModified: '2025-01-01' },
    ],
  })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(ruleIdsOf(report).sort(), [
    'decline-near-threshold',
    'decline-over-threshold',
    'freshness-page-unknown',
    'inbound-link-decline',
    'insufficient-volume',
    'stale-content',
  ])
  for (const finding of report.findings) {
    assert.equal(finding.severity, RULE_SEVERITY[finding.ruleId], finding.ruleId)
  }
  assert.equal(report.status, 'incomplete')
  t.diagnostic(`covered ${report.findings.length} findings`)
})

test('no finding this tool emits claims a cause or a search position', async (t) => {
  const site = await project(t, {
    rows: [
      ...pageRows('/guides/install', 60, 20),
      ...pageRows('/guides/upgrade', 100, 88),
      ...rowsFor('/blog/old', BASELINE.start, 4, 5),
      ...rowsFor('/guides/short', BASELINE.start, 30, 40),
      ...rowsFor('/guides/short', RECENT.start, 22, 40),
      { page: '/guides/upgrade', date: 'not-a-date', value: 1 },
    ],
    freshness: [
      { page: '/guides/install', lastModified: '2019-01-01', inboundLinks: { baseline: 80, recent: 10 } },
      { page: '/gone', lastModified: '2025-01-01' },
    ],
  })
  const report = await checkProject({ config: site.config })
  assert.ok(report.findings.length >= 7, 'the fixture must exercise several rules')
  for (const finding of report.findings) {
    assert.equal(findCausalClaim(finding.message), null, `${finding.ruleId} message: ${finding.message}`)
    if (finding.suggestion !== undefined) {
      assert.equal(findCausalClaim(finding.suggestion), null, `${finding.ruleId} suggestion: ${finding.suggestion}`)
    }
  }
})

test('the disclaimer is on every report, whatever the verdict', async (t) => {
  const cases = [
    ['pass', pageRows('/a', 40, 41)],
    ['fail', pageRows('/a', 60, 20)],
    ['incomplete', rowsFor('/a', BASELINE.start, 4, 5)],
  ]
  for (const [expected, rows] of cases) {
    const site = await project(t, { rows })
    const report = await checkProject({ config: site.config })
    assert.equal(report.status, expected)
    assert.equal(report.disclaimer, DISCLAIMER)
    assert.equal(renderReport(report).includes(DISCLAIMER), true)
  }
})

test('the disclaimer denies exactly what this tool is asked not to claim', () => {
  assert.match(DISCLAIMER, /establishes no cause/u)
  assert.match(DISCLAIMER, /no search ranking or position/u)
  assert.match(DISCLAIMER, /does not conclude that anything is wrong/u)
  assert.match(DISCLAIMER, /observed decline/u)
})

test('there is no network code in this tool', async () => {
  for (const [path, text] of await sources()) {
    for (const pattern of [/\bfetch\s*\(/u, /node:http/u, /node:https/u, /node:net/u, /node:dgram/u, /node:dns/u, /XMLHttpRequest/u, /WebSocket/u]) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})

test('there is no locale-sensitive comparison or formatting in this tool', async () => {
  for (const [path, text] of await sources()) {
    for (const pattern of [/localeCompare/u, /toLocaleString/u, /toLocaleDateString/u, /Intl\./u]) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})

test('there is no wall clock in this tool', async () => {
  for (const [path, text] of await sources()) {
    for (const pattern of [/Date\.now\s*\(/u, /new Date\s*\(\s*\)/u, /performance\.now/u]) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})

test('nothing in this tool writes to the filesystem', async () => {
  for (const [path, text] of await sources()) {
    for (const pattern of [/writeFile/u, /\bmkdir\b/u, /\brm\b\s*\(/u, /unlink/u, /appendFile/u]) {
      assert.equal(pattern.test(text), false, `${path} matches ${pattern}`)
    }
  }
})

test('every rule that reports missing evidence really does block a pass', () => {
  for (const ruleId of EVIDENCE_MISSING_RULES) {
    assert.equal(marksEvidenceMissing(ruleId), true, ruleId)
  }
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    if (!EVIDENCE_MISSING_RULES.includes(ruleId)) {
      assert.equal(marksEvidenceMissing(ruleId), false, `${ruleId} is marked without being listed`)
    }
  }
})
