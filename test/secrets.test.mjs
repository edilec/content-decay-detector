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
