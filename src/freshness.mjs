/**
 * Reading one link and freshness export.
 *
 * A record says when a page was last edited and, optionally, how many inbound
 * links pointed at it in each of the two comparison windows. Both are context
 * for a decline that the analytics export shows; neither is evidence of a
 * decline on its own, and neither is ever reported as one.
 */

import { parseIsoDate } from './dates.mjs'
import { MAX_PAGE_ID_LENGTH, at, makeFinding, msg, sanitize } from './rules.mjs'

export const FRESHNESS_SCHEMA_VERSION = '1'
export const FRESHNESS_KEYS = Object.freeze(['schemaVersion', 'pages'])
export const FRESHNESS_RECORD_KEYS = Object.freeze(['page', 'lastModified', 'inboundLinks'])
export const INBOUND_LINK_KEYS = Object.freeze(['baseline', 'recent'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readInboundLinks(value) {
  if (!isRecord(value)) return { ok: false, reason: 'has an "inboundLinks" that is not an object' }
  for (const key of Object.keys(value)) {
    if (!INBOUND_LINK_KEYS.includes(key)) {
      return { ok: false, reason: `has the unknown inboundLinks key "${sanitize(key, 60)}"` }
    }
  }
  for (const key of INBOUND_LINK_KEYS) {
    if (!Object.hasOwn(value, key)) return { ok: false, reason: `has no inboundLinks.${key}` }
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      return { ok: false, reason: `has an inboundLinks.${key} that is not a count of zero or more` }
    }
  }
  return { ok: true, baseline: value.baseline, recent: value.recent }
}

/** Validate one freshness record. */
export function readFreshnessRecord(record) {
  if (!isRecord(record)) return { ok: false, reason: 'is not an object' }
  for (const key of Object.keys(record)) {
    if (!FRESHNESS_RECORD_KEYS.includes(key)) {
      return {
        ok: false,
        reason: `has the unknown key "${sanitize(key, 60)}"; known keys are ${FRESHNESS_RECORD_KEYS.join(', ')}`,
      }
    }
  }
  if (typeof record.page !== 'string' || record.page.trim() === '') {
    return { ok: false, reason: 'has a "page" that is not a non-empty string' }
  }
  if (record.page.length > MAX_PAGE_ID_LENGTH) {
    return {
      ok: false,
      reason: `has a "page" of ${record.page.length} characters, over the ${MAX_PAGE_ID_LENGTH} character bound`,
    }
  }

  let lastModifiedDay = null
  if (Object.hasOwn(record, 'lastModified')) {
    const parsed = parseIsoDate(record.lastModified)
    if (!parsed.ok) return { ok: false, reason: `has a "lastModified" that ${parsed.reason}` }
    lastModifiedDay = parsed.day
  }

  let inboundLinks = null
  if (Object.hasOwn(record, 'inboundLinks')) {
    const parsed = readInboundLinks(record.inboundLinks)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    inboundLinks = { baseline: parsed.baseline, recent: parsed.recent }
  }

  if (lastModifiedDay === null && inboundLinks === null) {
    return { ok: false, reason: 'carries neither "lastModified" nor "inboundLinks", so it describes nothing' }
  }
  return { ok: true, page: record.page.trim(), lastModifiedDay, inboundLinks }
}

/**
 * Read a parsed freshness export document.
 *
 * Shaped exactly like `scanSeries`: an unusable document yields no records and
 * one finding, and every individually refused record is reported rather than
 * dropped in silence.
 */
export function scanFreshness(document, { file, maxRecords }) {
  const findings = []
  const reject = (ruleId, message, extra) => {
    findings.push(makeFinding(ruleId, message, at(file, null), extra))
    return { records: [], findings, recordsFound: 0 }
  }

  if (!isRecord(document)) {
    return reject('freshness-unparsable', msg`The freshness export is not a JSON object.`, {
      suggestion: `Supply an object with the keys ${FRESHNESS_KEYS.join(', ')}.`,
    })
  }
  for (const key of Object.keys(document)) {
    if (!FRESHNESS_KEYS.includes(key)) {
      return reject(
        'freshness-unparsable',
        msg`The freshness export has the unknown key "${sanitize(key, 60)}".`,
        { suggestion: `Known keys are ${FRESHNESS_KEYS.join(', ')}. A misspelled key is refused rather than ignored.` },
      )
    }
  }
  if (document.schemaVersion !== FRESHNESS_SCHEMA_VERSION) {
    return reject(
      'freshness-unparsable',
      msg`The freshness export declares schemaVersion ${document.schemaVersion === undefined ? '(missing)' : JSON.stringify(document.schemaVersion)}, not ${FRESHNESS_SCHEMA_VERSION}.`,
      { suggestion: `Set "schemaVersion": "${FRESHNESS_SCHEMA_VERSION}".` },
    )
  }
  if (!Array.isArray(document.pages)) {
    return reject('freshness-unparsable', msg`The freshness export has no "pages" array.`, {
      suggestion: 'Supply "pages" as an array of { page, lastModified, inboundLinks } objects.',
    })
  }
  if (document.pages.length > maxRecords) {
    return reject(
      'freshness-record-limit-exceeded',
      msg`The freshness export holds ${document.pages.length} records, over the limit of ${maxRecords}; none of them were read.`,
      { suggestion: 'Raise limits.maxFreshnessRecords deliberately, or split the export.' },
    )
  }

  const records = []
  for (const [index, entry] of document.pages.entries()) {
    const parsed = readFreshnessRecord(entry)
    if (!parsed.ok) {
      findings.push(makeFinding(
        'freshness-record-invalid',
        msg`Freshness record ${index} ${parsed.reason} and was not read.`,
        at(file, `/pages/${index}`),
        {
          evidence: JSON.stringify(entry) ?? String(entry),
          suggestion: 'Correct the record in the export. A record this tool cannot read is missing evidence.',
        },
      ))
      continue
    }
    records.push({
      index,
      file,
      page: parsed.page,
      lastModifiedDay: parsed.lastModifiedDay,
      inboundLinks: parsed.inboundLinks,
    })
  }

  return { records, findings, recordsFound: document.pages.length }
}
