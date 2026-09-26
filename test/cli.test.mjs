import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { DISCLAIMER, LINE_SEPARATORS, TOOL_ID, renderReport } from '../src/index.mjs'
import {
  BASELINE,
  REPO,
  pageRows,
  project,
  rowsFor,
  runCli,
} from './helpers.mjs'

const CLEAN = 'examples/clean/decay.config.json'
const BROKEN = 'examples/broken/decay.config.json'

const ids = (stdout) => JSON.parse(stdout).findings.map((finding) => finding.ruleId)

test('--help explains the tool on stderr and leaves stdout empty', async () => {
  for (const flag of ['--help', '-h']) {
    const run = await runCli([flag])
    assert.equal(run.code, 0, flag)
    assert.equal(run.stdout, '', 'stdout carries the report and nothing else')
    assert.match(run.stderr, /content-decay-detector/u)
    assert.match(run.stderr, /--minimum-volume/u)
    assert.match(run.stderr, /inconclusive, never "no decline"/u)
    assert.match(run.stderr, /never fetches anything/u)
  }
})

test('a usage error exits 2 with an empty stdout', async () => {
  for (const argv of [[], ['--config'], ['--nope', 'x'], ['--config', 'a.json', '--minimum-volume', 'lots'], ['--minimum-volume', '10']]) {
    const run = await runCli(argv)
    assert.equal(run.code, 2, JSON.stringify(argv))
    assert.equal(run.stdout, '', JSON.stringify(argv))
    assert.notEqual(run.stderr, '', JSON.stringify(argv))
  }
})

test('an unknown option is refused even on a run that would otherwise pass', async () => {
  // The plain usage errors above all exit 2 anyway because no config was
  // given. This is the case that distinguishes refusing an unknown option from
  // ignoring it: a typo next to a valid config must not be swallowed.
  const accepted = await runCli(['--config', CLEAN, '--json'])
  assert.equal(accepted.code, 0)

  const typo = await runCli(['--config', CLEAN, '--json', '--minimum-volumes', '10'])
  assert.equal(typo.code, 2, 'a misspelled option must not be ignored')
  assert.equal(typo.stdout, '')
  assert.match(typo.stderr, /Unknown option "--minimum-volumes"/u)
})

test('the clean example passes and prints a parseable report', async () => {
  const run = await runCli(['--config', CLEAN])
  assert.equal(run.code, 0)
  const report = JSON.parse(run.stdout)
  assert.equal(report.tool, TOOL_ID)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.scored, 3)
  assert.equal(report.disclaimer, DISCLAIMER)
  assert.match(run.stderr, /3 page\(s\) seen, 3 scored/u)
  assert.match(run.stderr, /Status pass/u)
})

test('the broken example shows both halves of the contract at once', async () => {
  const run = await runCli(['--config', BROKEN])
  assert.equal(run.code, 2)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'incomplete')
  const rules = report.findings.map((finding) => finding.ruleId)
  assert.ok(rules.includes('decline-over-threshold'), 'a falling page with enough volume is flagged')
  assert.ok(rules.includes('insufficient-volume'), 'a sparse page is inconclusive')
  assert.equal(report.summary.scored, 2)
  assert.equal(report.summary.inconclusive, 1)
  const sparse = report.findings.find((finding) => finding.ruleId === 'insufficient-volume')
  assert.match(sparse.message, /not an absence of decline/u)
})

test('a completed run with only a decline exits 1', async (t) => {
  const site = await project(t, { rows: pageRows('/guides/install', 60, 20) })
  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 1)
  assert.deepEqual(ids(run.stdout), ['decline-over-threshold'])
  assert.equal(JSON.parse(run.stdout).status, 'fail')
})

test('--json suppresses the human summary and keeps stdout intact', async () => {
  const plain = await runCli(['--config', CLEAN])
  const quiet = await runCli(['--config', CLEAN, '--json'])
  assert.equal(quiet.code, 0)
  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, plain.stdout)
  assert.notEqual(plain.stderr, '')
})

test('stdout is byte-identical across runs', async () => {
  const first = await runCli(['--config', BROKEN, '--json'])
  const second = await runCli(['--config', BROKEN, '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.endsWith('}\n'), true)
})

test('--minimum-volume reaches the comparison and changes the verdict', async (t) => {
  const site = await project(t, {
    rows: [...rowsFor('/blog/old', BASELINE.start, 24, 5), ...rowsFor('/blog/old', '2025-09-01', 24, 1)],
  })
  const asConfigured = await runCli(['--config', site.config, '--json'])
  assert.equal(asConfigured.code, 2)
  assert.deepEqual(ids(asConfigured.stdout), ['insufficient-volume'])

  const lowered = await runCli(['--config', site.config, '--minimum-volume', '100', '--json'])
  assert.equal(lowered.code, 1)
  assert.deepEqual(ids(lowered.stdout), ['decline-over-threshold'])
})

test('--root moves the input root without moving the config', async (t) => {
  const site = await project(t, { rows: pageRows('/a', 40, 41) })
  const run = await runCli(['--config', site.config, '--root', site.root, '--json'])
  assert.equal(run.code, 0)
  assert.equal(JSON.parse(run.stdout).status, 'pass')

  // Pointed one directory deeper, the same relative path resolves somewhere
  // that holds nothing, and the report says exactly which file was not read.
  const wrongRoot = await runCli(['--config', site.config, '--root', join(site.root, 'exports'), '--json'])
  assert.equal(wrongRoot.code, 2)
  assert.deepEqual(ids(wrongRoot.stdout), ['series-unreadable'])
  assert.equal(JSON.parse(wrongRoot.stdout).status, 'incomplete')
  assert.equal(JSON.parse(wrongRoot.stdout).findings[0].location.file, 'exports/analytics.json')

  // A root the config cannot reach out of is still refused with an empty stdout.
  const escaping = await runCli(['--config', site.config, '--root', join(site.root, 'exports', 'nowhere')])
  assert.equal(escaping.code, 2)
  assert.equal(escaping.stdout, '', 'a configuration refusal leaves stdout empty')
  assert.match(escaping.stderr, /input root could not be resolved/u)
})

test('a page id carrying a newline cannot forge a line in the human summary', async (t) => {
  const forged = '/a\nERROR   forged-rule                     everywhere'
  const site = await project(t, { rows: rowsFor(forged, BASELINE.start, 4, 5) })
  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stderr.includes('forged-rule'), true, 'the text is still reported')
  const summaryLines = run.stderr.split('\n').filter((line) => /^(ERROR|WARNING|INFO)/u.test(line))
  assert.equal(summaryLines.length, 1, 'exactly one finding was reported, so exactly one line is printed')
  assert.match(summaryLines[0], /^WARNING insufficient-volume/u)
})

test('the serialiser escapes the two JavaScript line terminators', () => {
  const [first, second] = [...LINE_SEPARATORS]
  const rendered = renderReport({ tool: TOOL_ID, note: `a${first}b${second}c` })
  assert.equal(rendered.includes(first), false, 'a raw U+2028 reached stdout')
  assert.equal(rendered.includes(second), false, 'a raw U+2029 reached stdout')
  assert.match(rendered, /a\\u2028b\\u2029c/u)
  assert.equal(JSON.parse(rendered).note, `a${first}b${second}c`)
  // The payload is valid JavaScript as well as valid JSON.
  assert.deepEqual(new Function(`return ${rendered}`)().note, `a${first}b${second}c`)
})

test('the example the check gate runs is the clean one', async () => {
  const run = await runCli(['--config', CLEAN], { cwd: REPO })
  assert.equal(run.code, 0, 'npm run example must exit 0')
})
