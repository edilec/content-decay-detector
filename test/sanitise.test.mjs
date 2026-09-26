/**
 * Untrusted input reaching output.
 *
 * Every string in a report that did not come from this tool's own vocabulary
 * came out of a file: a page identifier, a file path, a configuration key, a
 * parser's complaint about a document. Each of them reaches stdout as JSON and
 * stderr as a human summary, and several classes of character change what a
 * terminal, a log viewer or a CI annotation shows:
 *
 *   C0 U+0000-U+001F and DEL U+007F   forge lines and move the cursor
 *   C1 U+0080-U+009F                  U+0085 is a line break and U+009B is an
 *                                     8-bit CSI, so both forge lines too
 *   U+2028 and U+2029                 line terminators inside a JS string
 *   bidi controls and isolates        U+202E reverses displayed text, and the
 *                                     rest hide or reorder what follows
 *
 * The characters below are written as code points rather than as escape text,
 * so that no editor, transfer or tool can quietly turn one into something else.
 * Every case here drives a real file through the real CLI.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { sanitize } from '../src/index.mjs'
import {
  BASELINE,
  configJson,
  makeProject,
  project,
  removeProject,
  rowsFor,
  runCli,
  seriesJson,
} from './helpers.mjs'

/** Every class that must never reach stdout or stderr raw. */
const UNSAFE = [
  ['C0 NULL', 0x0000],
  ['C0 LINE FEED', 0x000a],
  ['C0 ESCAPE', 0x001b],
  ['C0 UNIT SEPARATOR', 0x001f],
  ['DELETE', 0x007f],
  ['C1 first', 0x0080],
  ['C1 NEXT LINE', 0x0085],
  ['C1 CONTROL SEQUENCE INTRODUCER', 0x009b],
  ['C1 last', 0x009f],
  ['LINE SEPARATOR', 0x2028],
  ['PARAGRAPH SEPARATOR', 0x2029],
  ['LEFT-TO-RIGHT MARK', 0x200e],
  ['RIGHT-TO-LEFT MARK', 0x200f],
  ['LEFT-TO-RIGHT EMBEDDING', 0x202a],
  ['RIGHT-TO-LEFT EMBEDDING', 0x202b],
  ['POP DIRECTIONAL FORMATTING', 0x202c],
  ['LEFT-TO-RIGHT OVERRIDE', 0x202d],
  ['RIGHT-TO-LEFT OVERRIDE', 0x202e],
  ['LEFT-TO-RIGHT ISOLATE', 0x2066],
  ['RIGHT-TO-LEFT ISOLATE', 0x2067],
  ['FIRST STRONG ISOLATE', 0x2068],
  ['POP DIRECTIONAL ISOLATE', 0x2069],
]

const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e)
const NEXT_LINE = String.fromCodePoint(0x0085)

/** A string carrying every unsafe class, each followed by a visible marker. */
function withEveryUnsafeCharacter(prefix) {
  return UNSAFE.reduce(
    (text, [, codePoint], index) => `${text}${String.fromCodePoint(codePoint)}k${index}`,
    prefix,
  )
}

const named = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * The one unsafe class a stream legitimately contains: U+000A is how both the
 * pretty-printed report and the human summary separate their own lines. It is
 * pinned separately -- inside every JSON string value, and by counting the
 * lines the summary prints.
 */
const LINE_FEED = 0x000a

function assertNothingRawIn(streams) {
  for (const [name, cp] of UNSAFE) {
    if (cp === LINE_FEED) continue
    const character = String.fromCodePoint(cp)
    for (const [stream, text] of Object.entries(streams)) {
      assert.equal(text.includes(character), false, `${name} (${named(cp)}) reached ${stream} raw`)
    }
  }
}

/** Every string the JSON payload carries, keys included. */
function stringsIn(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, found)
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.push(key)
      stringsIn(item, found)
    }
  }
  return found
}

function assertNothingRawInReport(stdout) {
  const strings = stringsIn(JSON.parse(stdout))
  for (const [name, cp] of UNSAFE) {
    const character = String.fromCodePoint(cp)
    for (const text of strings) {
      assert.equal(text.includes(character), false, `${name} (${named(cp)}) reached a report string raw`)
    }
  }
}

/** Lines a reader would take for a reported finding. */
const findingLines = (stderr) => stderr.split('\n').filter((line) => /^(ERROR|WARNING|INFO)/u.test(line))

test('sanitize strips every unsafe class and keeps the text around it', () => {
  for (const [name, cp] of UNSAFE) {
    assert.equal(sanitize(`a${String.fromCodePoint(cp)}b`), 'a b', name)
  }
  assert.equal(sanitize(withEveryUnsafeCharacter('/p')), `/p ${UNSAFE.map((entry, i) => `k${i}`).join(' ')}`)
})

test('an identifier carrying any unsafe class reaches neither stream raw', async (t) => {
  // The characters arrive through a page id -- an identifier, not an excerpt
  // of content -- so they pass through pointerForPage and through the message
  // template rather than through the evidence field.
  const page = withEveryUnsafeCharacter('/decay')
  const site = await project(t, {
    rows: [...rowsFor(page, BASELINE.start, 4, 5), ...rowsFor(page, '2025-09-01', 4, 1)],
  })
  const run = await runCli(['--config', site.config])

  assert.equal(run.code, 2)
  assertNothingRawIn({ stdout: run.stdout, stderr: run.stderr })
  assertNothingRawInReport(run.stdout)

  const report = JSON.parse(run.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['insufficient-volume'])
  assert.equal(report.findings[0].location.pointer, `/pages/~1decay ${UNSAFE.map((entry, i) => `k${i}`).join(' ')}`)
  assert.equal(report.findings[0].message.startsWith('/decay k0 '), true, 'the id is still reported')
  assert.equal(findingLines(run.stderr).length, 1, 'one finding must print exactly one line')
})

test('a right-to-left override in a page id cannot reverse the summary', async (t) => {
  const page = `/invoices/${RIGHT_TO_LEFT_OVERRIDE}gnidnep`
  const site = await project(t, {
    rows: [...rowsFor(page, BASELINE.start, 4, 5), ...rowsFor(page, '2025-09-01', 4, 1)],
  })
  const run = await runCli(['--config', site.config])
  assert.equal(run.stdout.includes(RIGHT_TO_LEFT_OVERRIDE), false)
  assert.equal(run.stderr.includes(RIGHT_TO_LEFT_OVERRIDE), false)
  assert.match(run.stderr, /\/pages\/~1invoices~1 gnidnep/u, 'the id is still shown, with the override removed')
})

test('an unsafe class in an export path reaches neither stream raw', async (t) => {
  const forged = `exports/a${NEXT_LINE}ERROR   forged-rule   everywhere${RIGHT_TO_LEFT_OVERRIDE}.json`
  const root = await makeProject({ 'decay.config.json': configJson({ series: [forged] }) })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'decay.config.json')])
  assert.equal(run.code, 2)
  assertNothingRawIn({ stdout: run.stdout, stderr: run.stderr })
  assertNothingRawInReport(run.stdout)
  const report = JSON.parse(run.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['series-unreadable'])
  assert.equal(report.findings[0].location.file.includes('forged-rule'), true, 'the path is still reported')
  assert.equal(findingLines(run.stderr).length, 1)
})

test('an unsafe class in an export key reaches neither the message nor the evidence raw', async (t) => {
  const key = `val${RIGHT_TO_LEFT_OVERRIDE}eu${NEXT_LINE}`
  const site = await project(t, {
    rows: [{ page: '/a', date: '2025-09-01', value: 1, [key]: 2 }],
  })
  const run = await runCli(['--config', site.config])
  assertNothingRawIn({ stdout: run.stdout, stderr: run.stderr })
  assertNothingRawInReport(run.stdout)

  const report = JSON.parse(run.stdout)
  const invalid = report.findings.find((finding) => finding.ruleId === 'row-invalid')
  assert.notEqual(invalid, undefined, 'the row with the unknown key was refused')
  assert.match(invalid.message, /unknown key "val eu"/u, 'the key is still named')
  // JSON.stringify escapes C0 and leaves C1 and the bidi controls alone, so the
  // evidence field is the second place the raw characters would arrive.
  assert.equal(invalid.evidence.includes('val eu'), true)
})

test('an unsafe class in a configuration key reaches stderr sanitised', async (t) => {
  const document = JSON.parse(configJson())
  document[`minimum${NEXT_LINE}Volumes`] = 10
  const root = await makeProject({
    'decay.config.json': `${JSON.stringify(document, null, 2)}\n`,
    'exports/analytics.json': seriesJson({ rows: [] }),
  })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'decay.config.json')])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '', 'a configuration refusal leaves stdout empty')
  assertNothingRawIn({ stderr: run.stderr })
  assert.equal(run.stderr.split('\n').filter((line) => line !== '').length, 1, 'one diagnostic is one line')
  assert.match(run.stderr, /Unknown key "minimum Volumes"/u)
})

test('the diagnostic for a config that is not JSON quotes it sanitised', async (t) => {
  // V8 puts a slice of the document into its parse error, so the config file's
  // own bytes reach stderr through the message. Nothing else sanitises them.
  const root = await makeProject({
    'decay.config.json': `nope${NEXT_LINE}ERROR   forged-rule   everywhere ${RIGHT_TO_LEFT_OVERRIDE}gnihton`,
  })
  t.after(() => removeProject(root))

  const run = await runCli(['--config', join(root, 'decay.config.json')])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assertNothingRawIn({ stderr: run.stderr })
  assert.match(run.stderr, /The config is not valid JSON/u)
  assert.equal(run.stderr.split('\n').filter((line) => line !== '').length, 1, 'one diagnostic is one line')
})
