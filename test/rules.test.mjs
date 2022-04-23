import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CAUSAL_TERMS,
  DEFAULT_LIMITS,
  EVIDENCE_MISSING_RULES,
  LIMIT_NAMES,
  MAX_PAGE_ID_LENGTH,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  assertNoCausalClaim,
  at,
  byCodeUnit,
  findCausalClaim,
  makeFinding,
  marksEvidenceMissing,
  msg,
  pointerForPage,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from '../src/index.mjs'

const DOCS = fileURLToPath(new URL('../docs/decay-rules.md', import.meta.url))

/**
 * A third, hand-written copy of the catalog.
 *
 * The code and the documentation can be edited together and still satisfy each
 * other, so this table exists to be edited a third time. Every entry is
 * (ruleId, severity, evidence missing).
 */
const HAND_WRITTEN_CATALOG = [
  ['decline-near-threshold', 'warning', false],
  ['decline-over-threshold', 'error', false],
  ['duplicate-observation', 'error', true],
  ['freshness-duplicate-page', 'error', true],
  ['freshness-not-utf8', 'error', true],
  ['freshness-page-unknown', 'info', false],
  ['freshness-record-invalid', 'error', true],
  ['freshness-record-limit-exceeded', 'error', true],
  ['freshness-too-large', 'error', true],
  ['freshness-unparsable', 'error', true],
  ['freshness-unreadable', 'error', true],
  ['inbound-link-decline', 'warning', false],
  ['insufficient-coverage', 'warning', true],
  ['insufficient-volume', 'warning', true],
  ['metric-mismatch', 'error', true],
  ['no-pages-scored', 'error', true],
  ['page-limit-exceeded', 'error', true],
  ['row-invalid', 'error', true],
  ['row-limit-exceeded', 'error', true],
  ['series-not-utf8', 'error', true],
  ['series-too-large', 'error', true],
  ['series-unparsable', 'error', true],
  ['series-unreadable', 'error', true],
  ['stale-content', 'info', false],
  ['window-coverage-mismatch', 'warning', true],
]

function parseTable(markdown, header) {
  const start = markdown.indexOf(header)
  assert.notEqual(start, -1, `the documentation has no "${header}" table`)
  const rows = []
  for (const line of markdown.slice(start).split('\n').slice(2)) {
    if (!line.startsWith('|')) break
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()))
  }
  assert.ok(rows.length > 0, `the "${header}" table has no rows`)
  return rows
}

test('the hand-written catalog and the code agree in both directions', () => {
  assert.deepEqual(
    HAND_WRITTEN_CATALOG.map(([ruleId]) => ruleId),
    RULE_IDS,
    'a rule exists in one place and not the other',
  )
  for (const [ruleId, severity, evidenceMissing] of HAND_WRITTEN_CATALOG) {
    assert.equal(severityFor(ruleId), severity, `${ruleId} severity`)
    assert.equal(marksEvidenceMissing(ruleId), evidenceMissing, `${ruleId} evidence-missing marking`)
  }
  assert.deepEqual(
    HAND_WRITTEN_CATALOG.filter(([, , missing]) => missing).map(([ruleId]) => ruleId),
    [...EVIDENCE_MISSING_RULES],
    'the evidence-missing list drifted from the hand-written catalog',
  )
})

test('the documented catalog and the code agree in both directions', async () => {
  const markdown = await readFile(DOCS, 'utf8')
  const rows = parseTable(markdown, '| Rule | Severity | Evidence missing | What it reports |')
  const documented = rows.map(([rule, severity, missing]) => [rule.replaceAll('`', ''), severity, missing])

  assert.deepEqual(documented.map(([rule]) => rule), RULE_IDS, 'documented rule ids differ from the code')
  for (const [rule, severity, missing] of documented) {
    assert.ok(SEVERITIES.includes(severity), `${rule} documents the unknown severity "${severity}"`)
    assert.equal(severityFor(rule), severity, `${rule} severity differs between the docs and the code`)
    assert.ok(missing === 'yes' || missing === 'no', `${rule} documents "${missing}" for evidence missing`)
    assert.equal(marksEvidenceMissing(rule), missing === 'yes', `${rule} evidence-missing marking differs`)
  }
  for (const ruleId of RULE_IDS) {
    assert.ok(documented.some(([rule]) => rule === ruleId), `${ruleId} is in the code and not in the docs`)
  }
})

test('the documented limits and the code agree in both directions', async () => {
  const markdown = await readFile(DOCS, 'utf8')
  const rows = parseTable(markdown, '| Limit | Default | Exceeding it reports |')
  const documented = rows.map(([name, value]) => [name.replaceAll('`', ''), Number(value)])

  assert.deepEqual(documented.map(([name]) => name), [...LIMIT_NAMES], 'documented limit names differ from the code')
  for (const [name, value] of documented) {
    assert.equal(DEFAULT_LIMITS[name], value, `${name} default differs between the docs and the code`)
  }
  for (const name of LIMIT_NAMES) {
    assert.ok(documented.some(([documentedName]) => documentedName === name), `${name} is in the code and not the docs`)
  }
})

test('every rule id maps to a known severity and an unknown one throws', () => {
  for (const ruleId of RULE_IDS) assert.ok(SEVERITIES.includes(RULE_SEVERITY[ruleId]), ruleId)
  assert.throws(() => severityFor('no-such-rule'), /Unknown ruleId "no-such-rule"/u)
  assert.throws(() => marksEvidenceMissing('no-such-rule'), /Unknown ruleId/u)
  assert.throws(() => makeFinding('no-such-rule', msg`x`, at(null, '/x')), /Unknown ruleId/u)
})

test('every evidence-missing rule is a real rule', () => {
  for (const ruleId of EVIDENCE_MISSING_RULES) {
    assert.ok(RULE_IDS.includes(ruleId), `${ruleId} is marked evidence-missing but is not in the catalog`)
  }
})

test('a finding takes its severity from the table, never from the call site', () => {
  const finding = makeFinding('insufficient-volume', msg`sparse`, at(null, '/pages/a'), { severity: 'error' })
  assert.equal(finding.severity, 'warning')
  assert.equal(Object.hasOwn(finding, 'severity'), true)
  assert.equal(makeFinding('decline-over-threshold', msg`x`, at(null, '/p')).severity, 'error')
})

test('a finding message must be built with the msg template', () => {
  assert.throws(
    () => makeFinding('row-invalid', 'a plain string', at(null, '/x')),
    /must build its message with the msg tagged template/u,
  )
  assert.doesNotThrow(() => makeFinding('row-invalid', msg`a checked message`, at(null, '/x')))
})

test('a message template may not claim cause or search position', () => {
  for (const phrase of [
    'the drop happened because of an edit',
    'traffic fell due to a redirect',
    'the page lost ranking',
    'the page was penalised',
    'this is the result of a migration',
  ]) {
    assert.throws(() => msg([phrase]), /may not claim cause or search position/u, phrase)
  }
  assert.equal(findCausalClaim('a plain observed difference'), null)
  assert.throws(() => assertNoCausalClaim('caused by nothing', 'A thing'), /A thing may not claim/u)
})

test('the causal guard checks the template and not the untrusted value', () => {
  // A page really can be called this. It must not crash the run, and it must
  // not be mistaken for this tool making the claim.
  const built = msg`${'/blog/why-we-were-penalised'} was not scored.`
  assert.equal(built.text, '/blog/why-we-were-penalised was not scored.')
  assert.throws(() => msg`the page was penalised`, /may not claim cause/u)
})

test('every causal term is actually caught by the guard', () => {
  for (const term of CAUSAL_TERMS) {
    assert.notEqual(findCausalClaim(`a sentence with ${term} in it`), null, term)
  }
})

test('untrusted strings are flattened and bounded wherever they reach output', () => {
  assert.equal(sanitize('one\ntwo\r\nthree'), 'one two three')
  assert.equal(sanitize(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`), 'a b c')
  assert.equal(sanitize(`x${String.fromCharCode(0)}y`), 'x y')
  const long = sanitize('a'.repeat(500))
  assert.equal(long.length, 200)
  assert.equal(long.endsWith('...'), true)
  assert.equal(sanitize('kept', 4), 'kept')
})

test('a forged newline in a page id cannot forge a line in a finding', () => {
  const finding = makeFinding(
    'insufficient-volume',
    msg`${'/a\nERROR   forged-rule    /elsewhere'} was not scored.`,
    at(null, pointerForPage('/a\nb')),
  )
  assert.equal(finding.message.includes('\n'), false)
  assert.equal(finding.location.pointer.includes('\n'), false)
  assert.equal(finding.location.pointer, '/pages/~1a b')
})

test('a page id is JSON Pointer escaped in the pointer it produces', () => {
  assert.equal(pointerForPage('/guides/install'), '/pages/~1guides~1install')
  assert.equal(pointerForPage('a~b'), '/pages/a~0b')
  assert.equal(pointerForPage('/a/b~c'), '/pages/~1a~1b~0c')
  assert.equal(pointerForPage('x'.repeat(MAX_PAGE_ID_LENGTH + 50)).length, MAX_PAGE_ID_LENGTH + '/pages/'.length)
})

test('ordering is by code unit, not by locale collation', () => {
  // 'S' is 0x53 and '_' is 0x5F, so by code unit URLS sorts before URL_ENTRIES.
  // Collation treats the underscore as ignorable and reverses them, which
  // produced a real ordering difference in this catalog.
  assert.equal(byCodeUnit('MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'), -1)
  assert.equal(byCodeUnit('MAX_DUPLICATE_URL_ENTRIES', 'MAX_DUPLICATE_URLS'), 1)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('findings sort by file, then pointer, then rule id, then message', () => {
  const finding = (ruleId, file, pointer, message = 'm') => ({
    ruleId,
    severity: severityFor(ruleId),
    message,
    location: at(file, pointer),
  })
  // Deliberately distinct in every key, so reversing any one of the four
  // comparisons changes the result.
  const input = [
    finding('stale-content', 'z.json', '/pages/1'),
    finding('row-invalid', 'a.json', '/rows/2'),
    finding('row-invalid', 'a.json', '/rows/1'),
    finding('duplicate-observation', 'a.json', '/rows/1'),
    finding('row-invalid', 'a.json', '/rows/1', 'aaa'),
  ]
  assert.deepEqual(
    sortFindings(input).map((entry) => [entry.location.file, entry.location.pointer, entry.ruleId, entry.message]),
    [
      ['a.json', '/rows/1', 'duplicate-observation', 'm'],
      ['a.json', '/rows/1', 'row-invalid', 'aaa'],
      ['a.json', '/rows/1', 'row-invalid', 'm'],
      ['a.json', '/rows/2', 'row-invalid', 'm'],
      ['z.json', '/pages/1', 'stale-content', 'm'],
    ],
  )
  assert.deepEqual(sortFindings([...input].reverse()), sortFindings(input), 'the sort depends on input order')
})

test('status is incomplete for missing evidence, whatever the severity', () => {
  const only = (ruleId) => [{ ruleId, severity: severityFor(ruleId), message: 'm', location: {} }]
  assert.equal(statusFor([]), 'pass')
  assert.equal(statusFor(only('stale-content')), 'pass')
  assert.equal(statusFor(only('decline-near-threshold')), 'pass')
  assert.equal(statusFor(only('decline-over-threshold')), 'fail')
  for (const ruleId of EVIDENCE_MISSING_RULES) {
    assert.equal(statusFor(only(ruleId)), 'incomplete', `${ruleId} alone must not be able to pass or fail cleanly`)
  }
  assert.equal(
    statusFor([...only('decline-over-threshold'), ...only('insufficient-volume')]),
    'incomplete',
    'missing evidence outranks a completed failure',
  )
})

test('a warning-severity evidence-missing rule still blocks a pass', () => {
  // These three are the whole point of the evidence-missing list: each is only
  // a warning, so its membership in that list is the only thing standing
  // between a page the tool could not judge and a green run.
  for (const ruleId of ['insufficient-volume', 'insufficient-coverage', 'window-coverage-mismatch']) {
    assert.equal(severityFor(ruleId), 'warning', ruleId)
    assert.equal(marksEvidenceMissing(ruleId), true, ruleId)
    assert.equal(statusFor([{ ruleId, severity: 'warning', message: 'm', location: {} }]), 'incomplete', ruleId)
  }
})
