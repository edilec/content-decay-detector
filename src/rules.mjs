/**
 * The rule catalog, the severity table, and everything that turns findings into
 * a status.
 *
 * Three separate defences live here, and each one exists because its absence
 * has produced a green build over a real failure somewhere in this catalog:
 *
 * 1. Severity is declared exactly once, in `RULE_SEVERITY`. Every finding takes
 *    its severity from that table, and an unknown rule id throws rather than
 *    defaulting to something harmless.
 * 2. `status` is derived from the findings, not from a mutable flag. A run
 *    whose evidence was missing, sparse, truncated or undecodable is
 *    `incomplete`, and there is no single assignment whose deletion would let
 *    an unread or unscored input report `pass`.
 * 3. A finding's message must be built with the `msg` tagged template. The
 *    template's own literals are checked for causal and ranking language and
 *    the interpolated values -- which come from untrusted export files -- are
 *    sanitised. This tool observes a difference between two supplied numbers;
 *    it is not allowed to phrase that as a cause or as a ranking claim.
 */

/** Deterministic order: UTF-16 code unit, never locale collation. */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

export const RULE_SEVERITY = Object.freeze({
  'decline-near-threshold': 'warning',
  'decline-over-threshold': 'error',
  'duplicate-observation': 'error',
  'freshness-duplicate-page': 'error',
  'freshness-not-utf8': 'error',
  'freshness-page-unknown': 'info',
  'freshness-record-invalid': 'error',
  'freshness-record-limit-exceeded': 'error',
  'freshness-too-large': 'error',
  'freshness-unparsable': 'error',
  'freshness-unreadable': 'error',
  'inbound-link-decline': 'warning',
  'insufficient-coverage': 'warning',
  'insufficient-volume': 'warning',
  'metric-mismatch': 'error',
  'no-pages-scored': 'error',
  'page-limit-exceeded': 'error',
  'row-invalid': 'error',
  'row-limit-exceeded': 'error',
  'series-not-utf8': 'error',
  'series-too-large': 'error',
  'series-unparsable': 'error',
  'series-unreadable': 'error',
  'stale-content': 'info',
  'window-coverage-mismatch': 'warning',
})

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * Rules that mean the tool did not obtain the evidence a verdict would need.
 * Any one of them makes the whole report `incomplete` and the process exit 2,
 * whatever the rule's own severity happens to be.
 *
 * `insufficient-volume`, `insufficient-coverage` and `window-coverage-mismatch`
 * are the reason this list is not merely decoration. All three are `warning`
 * severity, so membership here is the only thing standing between a page the
 * tool could not judge and a green run. Sparse data is inconclusive; it is
 * never "no decline was found".
 */
export const EVIDENCE_MISSING_RULES = Object.freeze([
  'duplicate-observation',
  'freshness-duplicate-page',
  'freshness-not-utf8',
  'freshness-record-invalid',
  'freshness-record-limit-exceeded',
  'freshness-too-large',
  'freshness-unparsable',
  'freshness-unreadable',
  'insufficient-coverage',
  'insufficient-volume',
  'metric-mismatch',
  'no-pages-scored',
  'page-limit-exceeded',
  'row-invalid',
  'row-limit-exceeded',
  'series-not-utf8',
  'series-too-large',
  'series-unparsable',
  'series-unreadable',
  'window-coverage-mismatch',
].sort(byCodeUnit))

const EVIDENCE_MISSING_SET = new Set(EVIDENCE_MISSING_RULES)

export const EVIDENCE_LIMIT = 200
export const MAX_PAGE_ID_LENGTH = 256

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${ruleId}"`)
  return severity
}

export function marksEvidenceMissing(ruleId) {
  severityFor(ruleId)
  return EVIDENCE_MISSING_SET.has(ruleId)
}

/**
 * Words this tool is not entitled to use about its own observations.
 *
 * It compares two windows of numbers that somebody else exported. It cannot see
 * a search engine, a competitor, an edit, or a redirect, so it may not say that
 * one thing produced another, and it may not talk about position in a result
 * set at all.
 */
export const CAUSAL_TERMS = Object.freeze([
  'because', 'cause', 'caused', 'causes', 'causing', 'due to', 'result of',
  'resulted in', 'results in', 'leads to', 'lead to', 'led to', 'triggered',
  'rank', 'ranks', 'ranked', 'ranking', 'rankings', 'position', 'positions',
  'penalty', 'penalties', 'penalise', 'penalised', 'penalize', 'penalized',
  'demoted', 'deindexed', 'punished', 'blame', 'fault', 'therefore', 'hence',
])

const CAUSAL_PATTERN = new RegExp(
  `\\b(?:${CAUSAL_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})\\b`,
  'iu',
)

export function findCausalClaim(text) {
  const match = CAUSAL_PATTERN.exec(String(text))
  return match === null ? null : match[0]
}

export function assertNoCausalClaim(text, what) {
  const term = findCausalClaim(text)
  if (term !== null) {
    throw new Error(`${what} may not claim cause or search position: "${term}" in ${JSON.stringify(String(text))}`)
  }
}

/**
 * U+2028 and U+2029 are written here as code points rather than as escape text
 * so that no editor, transfer or tool can quietly turn the escape into the
 * character it names.
 */
export const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029)

const UNSAFE_CHARACTERS = new RegExp('[\\p{Cc}\\p{Cf}' + LINE_SEPARATORS + ']', 'gu')

/**
 * A bounded, control-character-free rendering of an untrusted string.
 *
 * Page identifiers, file names and metric names all arrive from export files
 * and all reach the report and the human summary. An identifier carrying a
 * newline forged extra lines in a shipped tool's human report, so every
 * untrusted string is flattened here -- not only the `evidence` field.
 */
export function sanitize(value, limit = EVIDENCE_LIMIT) {
  const flat = String(value)
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/**
 * What a `JSON.parse` failure may say about a file this tool did not write.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. An export
 * or a config short enough to be only a credential is therefore reproduced in
 * full by its own error message, and `sanitize` does not stop it: that strips
 * control characters and cuts from the end, while the quoted input sits at the
 * front.
 *
 * Position, line and column are the useful half and say nothing about content,
 * so they are kept whole. The quoted half never leaves this function. The
 * closing guard is deliberate belt and braces: every parse message V8 emits
 * without a snippet quotes JSON punctuation with apostrophes and holds no
 * double quote at all, so a double quote surviving to the end means a wording
 * this function has not been taught, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/u

/**
 * The shape that quotes the input. It is recognised FIRST, and the order is the
 * defence: an export whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the document
 * straight back out. The `s` flag matters too, because the quoted span can
 * carry a newline. A leading `...` means the quoted run came from the middle of
 * the document rather than its start.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/** A message whose literals have been checked and whose values are sanitised. */
export class SafeMessage {
  constructor(text) {
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }
}

/**
 * Build a finding message.
 *
 * The tagged-template split is the point: `strings` is this tool's own voice
 * and is checked for causal and ranking language, while `values` come from
 * input files and are only sanitised. A page named `/why-we-were-penalised`
 * must not crash the run, and a sentence this tool wrote saying a decline was
 * caused by something must not ship.
 */
export function msg(strings, ...values) {
  let out = ''
  for (let index = 0; index < strings.length; index += 1) {
    assertNoCausalClaim(strings[index], 'A finding message')
    out += strings[index]
    if (index < values.length) out += sanitize(values[index])
  }
  return new SafeMessage(out)
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

/** A documented field path for a page, with JSON Pointer escaping applied. */
export function pointerForPage(page) {
  const escaped = sanitize(page, MAX_PAGE_ID_LENGTH).replace(/~/gu, '~0').replace(/\//gu, '~1')
  return `/pages/${escaped}`
}

export function makeFinding(ruleId, message, location, extra = {}) {
  if (!(message instanceof SafeMessage)) {
    throw new Error(`Finding "${ruleId}" must build its message with the msg tagged template`)
  }
  const finding = { ruleId, severity: severityFor(ruleId), message: message.text, location }
  if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence)
  if (extra.suggestion !== undefined) {
    assertNoCausalClaim(extra.suggestion, 'A finding suggestion')
    finding.suggestion = extra.suggestion
  }
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/**
 * Status is a function of the findings alone.
 *
 * Missing evidence outranks everything, including an error: a run that read
 * half its inputs has not established that the half it did read is the whole
 * story. There is no flag to delete.
 */
export function statusFor(findings) {
  for (const finding of findings) {
    if (EVIDENCE_MISSING_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
