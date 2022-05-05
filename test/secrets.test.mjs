import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { project, runCli } from './helpers.mjs'

/**
 * A parse failure must not reproduce the file it failed on.
 *
 * V8 reports a `JSON.parse` failure two ways. One names a position and says
 * nothing about the content. The other quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- the whole
 * document when it is short, a ten-character prefix when it is not. An export
 * or a config short enough to be only a credential was therefore published by
 * the very message that failed to read it, on exactly the path a malformed or
 * untrusted file takes.
 *
 * `sanitize` never fixed this: it strips control characters and cuts from the
 * end, and the quoted input sits at the front of the message. The canary below
 * is AWS's published documentation placeholder, not a key.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

/** Every prefix of the canary down to eight characters, longest first. */
function prefixes(value) {
  const found = []
  for (let length = value.length; length >= 8; length -= 1) found.push(value.slice(0, length))
  return found
}

function assertNoCanary(result, label) {
  for (const prefix of prefixes(CANARY)) {
    assert.equal(result.stdout.includes(prefix), false, `${label}: stdout carries ${prefix}`)
    assert.equal(result.stderr.includes(prefix), false, `${label}: stderr carries ${prefix}`)
  }
}

test('an export that is only a credential is not echoed by the finding that failed to read it', async (t) => {
  const { config } = await project(t, { files: { 'exports/analytics.json': CANARY } })
  const result = await runCli(['--config', config])
  assert.equal(result.code, 2)
  assertNoCanary(result, 'series export')

  const finding = JSON.parse(result.stdout).findings.find((item) => item.ruleId === 'series-unparsable')
  assert.equal(finding.message, "The analytics export is not valid JSON: unexpected token 'A' at the start of the document.")
})

test('a longer export is not echoed by its ten-character prefix either', async (t) => {
  const longer = `${CANARY} followed by a great deal of content nobody should read back`
  const { config } = await project(t, { files: { 'exports/analytics.json': longer } })
  const result = await runCli(['--config', config])
  assert.equal(result.code, 2)
  assertNoCanary(result, 'long series export')
})

test('a freshness export that is only a credential is not echoed either', async (t) => {
  const { config } = await project(t, {
    freshness: [],
    files: { 'exports/freshness.json': CANARY },
  })
  const result = await runCli(['--config', config])
  assert.equal(result.code, 2)
  assertNoCanary(result, 'freshness export')
  assert.equal(JSON.parse(result.stdout).findings.some((item) => item.ruleId === 'freshness-unparsable'), true)
})

test('a config that is only a credential is not echoed to stderr', async (t) => {
  const { root } = await project(t, { files: { 'broken.config.json': CANARY } })
  const result = await runCli(['--config', `${root}/broken.config.json`])
  assert.equal(result.code, 2)
  assertNoCanary(result, 'config')
  assert.match(result.stderr, /The config is not valid JSON: unexpected token 'A' at the start of the document/u)
})

test('the position, line and column survive, because a parse error that says nothing is a defect', async (t) => {
  const { config } = await project(t, {
    files: { 'exports/analytics.json': '{"schemaVersion": "1", "token": "hunter2-correct-horse" "rows": []}' },
  })
  const result = await runCli(['--config', config])
  const finding = JSON.parse(result.stdout).findings.find((item) => item.ruleId === 'series-unparsable')
  assert.match(finding.message, /at position \d+ \(line \d+ column \d+\)/u)
  assert.equal(finding.message.includes('hunter2'), false)
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const cases = [
    [CANARY, "unexpected token 'A' at the start of the document"],
    ['password=hunter2-correct-horse', "unexpected token 'p' at the start of the document"],
    ['', 'Unexpected end of JSON input'],
    ['{"a": 1', "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)"],
  ]
  for (const [document, expected] of cases) {
    try {
      JSON.parse(document)
      assert.fail(`${document} parsed`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected, JSON.stringify(document))
    }
  }

  // A message this tool has never seen still yields something printable, and
  // an error with no message at all does not throw on its way into a finding.
  assert.equal(parseFailureDetail(new Error('something new from a future V8')), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})

/**
 * The ordering inside `parseFailureDetail` is the whole defence, so it is
 * pinned directly rather than only through the CLI.
 *
 * Searching for the offset BEFORE recognising the quoting shape looks safe and
 * is not: a document whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, the offset search
 * then finds that phrase INSIDE the quoted span, and the slice hands the
 * document straight back. These cases fail if the order is reverted.
 */

/** The detail for a document that must not parse. */
function detailFor(document) {
  let thrown = null
  try {
    JSON.parse(document)
  } catch (error) {
    thrown = error
  }
  assert.notEqual(thrown, null, `${JSON.stringify(document)} was supposed to be unparseable`)
  return parseFailureDetail(thrown)
}

/** Every prefix of `document` from four characters up, longest first. */
function assertNoPrefixOf(document, detail, label) {
  for (let length = Math.min(document.length, 40); length >= 4; length -= 1) {
    const prefix = document.slice(0, length)
    assert.equal(detail.includes(prefix), false, `${label}: the detail carries ${JSON.stringify(prefix)}`)
  }
}

test('a document whose own text reads "at position 1" does not smuggle itself out', () => {
  const detail = detailFor('at position 1')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail.includes('at position 1'), false, `the document came back: ${detail}`)
  assert.equal(detail, "unexpected token 'a' at the start of the document")
})

test('a document that is nothing but a credential never appears in the detail', () => {
  const detail = detailFor(CANARY)
  assert.equal(detail.includes(CANARY), false, `the canary came back: ${detail}`)
  assertNoPrefixOf(CANARY, detail, 'credential-only document')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a long document does not leak the ten characters V8 quotes from its head', () => {
  const document = `${CANARY} followed by a great deal of content nobody should read back`
  const detail = detailFor(document)
  assertNoPrefixOf(document, detail, 'long document')
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a quoted span carrying a newline is still recognised as the quoting shape', () => {
  // Without the `s` flag the quoting branch misses this message entirely.
  const detail = detailFor('}x\n')
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.equal(detail, "unexpected token '}' at the start of the document")
})

test('the genuinely safe positional form keeps its position, line and column', () => {
  // A helper that answered the generic sentence for everything would pass every
  // leak test above while destroying every diagnostic. This is the pin.
  const detail = detailFor('{"a": 1 "b": 2}')
  assert.match(detail, /at position 8 \(line 1 column 9\)$/u)
  assert.equal(detail.includes('"'), false, `a quoted span survived: ${detail}`)
  assert.notEqual(detail, 'the document could not be parsed as JSON')
})

test('an empty document keeps V8 own words', () => {
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
})
