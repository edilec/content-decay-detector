/**
 * Reading one analytics export.
 *
 * The export is a JSON document naming its metric and carrying one row per
 * page per day. Rows are validated individually and a row that cannot be
 * trusted is dropped *and reported*: a dropped row is missing evidence, so the
 * run cannot pass on what is left. Silently skipping a malformed row would be
 * the whole failure mode this catalog keeps finding.
 */

import { parseIsoDate } from './dates.mjs'
import { MAX_PAGE_ID_LENGTH, at, makeFinding, msg, sanitize } from './rules.mjs'

export const SERIES_SCHEMA_VERSION = '1'
export const SERIES_KEYS = Object.freeze(['schemaVersion', 'metric', 'rows'])
export const ROW_KEYS = Object.freeze(['page', 'date', 'value'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Validate one row. Returns either a usable observation or a refusal reason. */
export function readRow(row) {
  if (!isRecord(row)) return { ok: false, reason: 'is not an object' }
  for (const key of Object.keys(row)) {
    if (!ROW_KEYS.includes(key)) {
      return { ok: false, reason: `has the unknown key "${sanitize(key, 60)}"; known keys are ${ROW_KEYS.join(', ')}` }
    }
  }
  for (const key of ROW_KEYS) {
    if (!Object.hasOwn(row, key)) return { ok: false, reason: `has no "${key}"` }
  }
  if (typeof row.page !== 'string' || row.page.trim() === '') {
    return { ok: false, reason: 'has a "page" that is not a non-empty string' }
  }
  if (row.page.length > MAX_PAGE_ID_LENGTH) {
    return { ok: false, reason: `has a "page" of ${row.page.length} characters, over the ${MAX_PAGE_ID_LENGTH} character bound` }
  }
  const date = parseIsoDate(row.date)
  if (!date.ok) return { ok: false, reason: `has a "date" that ${date.reason}` }
  if (typeof row.value !== 'number' || !Number.isFinite(row.value)) {
    return { ok: false, reason: 'has a "value" that is not a finite number' }
  }
  if (row.value < 0) return { ok: false, reason: 'has a negative "value"' }
  return { ok: true, page: row.page.trim(), day: date.day, date: row.date, value: row.value }
}

/**
 * Read a parsed analytics export document.
 *
 * `file` is the report-relative path used for every finding this produces.
 * Returns the accepted observations and the findings explaining anything that
 * was refused. When the document itself is unusable the observation list is
 * empty and exactly one finding says why.
 */
export function scanSeries(document, { file, metric, maxRows }) {
  const findings = []
  const reject = (ruleId, message, extra) => {
    findings.push(makeFinding(ruleId, message, at(file, null), extra))
    return { observations: [], findings, rowsFound: 0 }
  }

  if (!isRecord(document)) {
    return reject('series-unparsable', msg`The analytics export is not a JSON object.`, {
      suggestion: `Supply an object with the keys ${SERIES_KEYS.join(', ')}.`,
    })
  }
  for (const key of Object.keys(document)) {
    if (!SERIES_KEYS.includes(key)) {
      return reject(
        'series-unparsable',
        msg`The analytics export has the unknown key "${sanitize(key, 60)}".`,
        { suggestion: `Known keys are ${SERIES_KEYS.join(', ')}. A misspelled key is refused rather than ignored.` },
      )
    }
  }
  if (document.schemaVersion !== SERIES_SCHEMA_VERSION) {
    return reject(
      'series-unparsable',
      msg`The analytics export declares schemaVersion ${document.schemaVersion === undefined ? '(missing)' : JSON.stringify(document.schemaVersion)}, not ${SERIES_SCHEMA_VERSION}.`,
      { suggestion: `Set "schemaVersion": "${SERIES_SCHEMA_VERSION}".` },
    )
  }
  if (typeof document.metric !== 'string' || document.metric.trim() === '') {
    return reject('series-unparsable', msg`The analytics export names no metric.`, {
      suggestion: 'Give the export a "metric" string naming what the values count.',
    })
  }
  if (document.metric.trim() !== metric) {
    return reject(
      'metric-mismatch',
      msg`The analytics export measures "${document.metric}" but the configuration compares "${metric}", so none of its rows were used.`,
      { suggestion: 'Compare one metric at a time: set config.metric to match the export, or supply the matching export.' },
    )
  }
  if (!Array.isArray(document.rows)) {
    return reject('series-unparsable', msg`The analytics export has no "rows" array.`, {
      suggestion: 'Supply "rows" as an array of { page, date, value } objects.',
    })
  }
  if (document.rows.length > maxRows) {
    return reject(
      'row-limit-exceeded',
      msg`The analytics export holds ${document.rows.length} rows, over the limit of ${maxRows}; none of them were read.`,
      { suggestion: 'Raise limits.maxRows deliberately, or split the export.' },
    )
  }

  const observations = []
  for (const [index, row] of document.rows.entries()) {
    const parsed = readRow(row)
    if (!parsed.ok) {
      findings.push(makeFinding(
        'row-invalid',
        msg`Row ${index} ${parsed.reason} and was not read.`,
        at(file, `/rows/${index}`),
        {
          evidence: JSON.stringify(row) ?? String(row),
          suggestion: 'Correct the row in the export. A row this tool cannot read is missing evidence, not a zero.',
        },
      ))
      continue
    }
    observations.push({ index, file, page: parsed.page, day: parsed.day, date: parsed.date, value: parsed.value })
  }

  return { observations, findings, rowsFound: document.rows.length }
}
