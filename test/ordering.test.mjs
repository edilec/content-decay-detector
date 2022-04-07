/**
 * Report order, pinned by what the report actually emits.
 *
 * Scanning the source for `localeCompare` or `Intl.` is not a determinism
 * test: any comparator that folds punctuation or case collates the same way
 * without using either token, and the scan passes while the order becomes a
 * property of whoever wrote the comparator rather than of the input.
 *
 * So the inputs here are chosen to order *differently* under code units and
 * under collation -- `URLS` before `URL_ENTRIES` because `S` (0x53) precedes
 * `_` (0x5F), `Z` before `a` because 0x5A precedes 0x61 -- and each test
 * asserts the exact sequence the report comes out in.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { at, buildReport, sortFindings } from '../src/index.mjs'
import { BASELINE, configJson, makeProject, removeProject, rowsFor, runCli } from './helpers.mjs'

const EMPTY_COUNTS = { checked: 0, scored: 0, inconclusive: 0, declining: 0, observations: 0 }

test('two findings from different files come out in code-unit order of the file', async (t) => {
  // Neither export exists, so each produces one finding naming its own path.
  const root = await makeProject({
    'decay.config.json': configJson({ series: ['exports/URLS.json', 'exports/URL_ENTRIES.json'] }),
  })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'decay.config.json'), '--json'])
  assert.equal(run.code, 2)
  assert.deepEqual(
    JSON.parse(run.stdout).findings.map((finding) => [finding.ruleId, finding.location.file]),
    [
      ['series-unreadable', 'exports/URLS.json'],
      ['series-unreadable', 'exports/URL_ENTRIES.json'],
    ],
    'collation puts URL_ENTRIES first by treating the underscore as ignorable',
  )
})

test('two findings about different pages come out in code-unit order of the pointer', async (t) => {
  const sparse = (page) => [
    ...rowsFor(page, BASELINE.start, 4, 5),
    ...rowsFor(page, '2025-09-01', 4, 1),
  ]
  const root = await makeProject({
    'decay.config.json': configJson(),
    'exports/analytics.json': `${JSON.stringify({
      schemaVersion: '1',
      metric: 'sessions',
      rows: [...sparse('/URL_ENTRIES'), ...sparse('/URLS')],
    }, null, 2)}\n`,
  })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'decay.config.json'), '--json'])
  assert.equal(run.code, 2)
  assert.deepEqual(
    JSON.parse(run.stdout).findings.map((finding) => finding.location.pointer),
    ['/pages/~1URLS', '/pages/~1URL_ENTRIES'],
    'the rows arrive in the other order, so this is the sort and not the input',
  )
})

test('each of the four sort keys orders by code unit, not by collation', () => {
  const finding = (ruleId, file, pointer, message) => ({
    ruleId,
    severity: 'error',
    message,
    location: at(file, pointer),
  })
  // Every pair below differs in exactly one key, and every pair is ordered the
  // other way round by any comparator that folds case or punctuation.
  const input = [
    finding('row-invalid', 'a.json', '/rows/1', 'alpha'),
    finding('row-invalid', 'a.json', '/rows/1', 'Zulu'),
    finding('a-rule', 'a.json', '/rows/2', 'm'),
    finding('Z-rule', 'a.json', '/rows/2', 'm'),
    finding('row-invalid', 'a.json', '/rows/a', 'm'),
    finding('row-invalid', 'a.json', '/rows/Z', 'm'),
    finding('row-invalid', 'a.json', '/rows/3', 'm'),
    finding('row-invalid', 'Z.json', '/rows/3', 'm'),
  ]
  const expected = [
    ['Z.json', '/rows/3', 'row-invalid', 'm'],
    ['a.json', '/rows/1', 'row-invalid', 'Zulu'],
    ['a.json', '/rows/1', 'row-invalid', 'alpha'],
    ['a.json', '/rows/2', 'Z-rule', 'm'],
    ['a.json', '/rows/2', 'a-rule', 'm'],
    ['a.json', '/rows/3', 'row-invalid', 'm'],
    ['a.json', '/rows/Z', 'row-invalid', 'm'],
    ['a.json', '/rows/a', 'row-invalid', 'm'],
  ]
  const keys = (findings) => findings.map((entry) => [
    entry.location.file,
    entry.location.pointer,
    entry.ruleId,
    entry.message,
  ])

  assert.deepEqual(keys(sortFindings(input)), expected)
  assert.deepEqual(keys(sortFindings([...input].reverse())), expected, 'the sort depends on input order')
  // The report is what a consumer reads, so pin it there too.
  assert.deepEqual(keys(buildReport(input, EMPTY_COUNTS).findings), expected)
})
