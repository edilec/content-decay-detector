import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRESHNESS_RECORD_KEYS,
  MAX_PAGE_ID_LENGTH,
  ROW_KEYS,
  readFreshnessRecord,
  readRow,
  scanFreshness,
  scanSeries,
} from '../src/index.mjs'

const SERIES_OPTIONS = { file: 'exports/analytics.json', metric: 'sessions', maxRows: 1000 }
const FRESHNESS_OPTIONS = { file: 'exports/freshness.json', maxRecords: 1000 }

const goodRow = (overrides = {}) => ({ page: '/a', date: '2025-09-01', value: 12, ...overrides })
const series = (document, options = {}) => scanSeries(document, { ...SERIES_OPTIONS, ...options })
const freshness = (document, options = {}) => scanFreshness(document, { ...FRESHNESS_OPTIONS, ...options })
const ids = (result) => result.findings.map((finding) => finding.ruleId)

test('a well-formed analytics export yields observations and no findings', () => {
  const result = series({ schemaVersion: '1', metric: 'sessions', rows: [goodRow(), goodRow({ date: '2025-09-02' })] })
  assert.deepEqual(result.findings, [])
  assert.equal(result.observations.length, 2)
  assert.deepEqual(
    result.observations.map((entry) => [entry.page, entry.date, entry.value, entry.index]),
    [['/a', '2025-09-01', 12, 0], ['/a', '2025-09-02', 12, 1]],
  )
})

test('an unknown key anywhere in the export is refused, not ignored', () => {
  assert.deepEqual(ids(series({ schemaVersion: '1', metric: 'sessions', rows: [], row: [] })), ['series-unparsable'])
  const typo = series({ schemaVersion: '1', metric: 'sessions', rows: [{ page: '/a', date: '2025-09-01', valeu: 12 }] })
  assert.deepEqual(ids(typo), ['row-invalid'])
  assert.match(typo.findings[0].message, /unknown key "valeu"/u)
  assert.equal(typo.observations.length, 0)
})

test('a document that is not the expected shape produces exactly one finding', () => {
  for (const document of [null, 'text', 42, []]) {
    assert.deepEqual(ids(series(document)), ['series-unparsable'], JSON.stringify(document))
  }
  assert.deepEqual(ids(series({ schemaVersion: '2', metric: 'sessions', rows: [] })), ['series-unparsable'])
  assert.deepEqual(ids(series({ schemaVersion: '1', metric: '  ', rows: [] })), ['series-unparsable'])
  assert.deepEqual(ids(series({ schemaVersion: '1', metric: 'sessions', rows: {} })), ['series-unparsable'])
})

test('an export of a different metric is refused and none of its rows are used', () => {
  const result = series({ schemaVersion: '1', metric: 'users', rows: [goodRow()] })
  assert.deepEqual(ids(result), ['metric-mismatch'])
  assert.equal(result.observations.length, 0)
  assert.match(result.findings[0].message, /"users"/u)
  assert.match(result.findings[0].message, /"sessions"/u)
})

test('the row limit is enforced and nothing is read past it', () => {
  const rows = Array.from({ length: 4 }, (unused, index) => goodRow({ date: `2025-09-0${index + 1}` }))
  const result = series({ schemaVersion: '1', metric: 'sessions', rows }, { maxRows: 3 })
  assert.deepEqual(ids(result), ['row-limit-exceeded'])
  assert.equal(result.observations.length, 0)
  assert.match(result.findings[0].message, /over the limit of 3/u)
  assert.deepEqual(ids(series({ schemaVersion: '1', metric: 'sessions', rows }, { maxRows: 4 })), [])
})

test('every kind of unusable row is named and dropped', () => {
  const cases = [
    [goodRow({ page: '' }), /non-empty string/u],
    [goodRow({ page: 7 }), /non-empty string/u],
    [goodRow({ page: 'x'.repeat(MAX_PAGE_ID_LENGTH + 1) }), /over the 256 character bound/u],
    [goodRow({ date: '2025-02-30' }), /real calendar date/u],
    [goodRow({ date: 'yesterday' }), /YYYY-MM-DD/u],
    [goodRow({ value: '12' }), /finite number/u],
    [goodRow({ value: Number.NaN }), /finite number/u],
    [goodRow({ value: -1 }), /negative/u],
    [{ page: '/a', date: '2025-09-01' }, /has no "value"/u],
    [{ page: '/a', value: 1 }, /has no "date"/u],
    [{ date: '2025-09-01', value: 1 }, /has no "page"/u],
    ['not an object', /is not an object/u],
  ]
  for (const [row, pattern] of cases) {
    const result = series({ schemaVersion: '1', metric: 'sessions', rows: [row] })
    assert.deepEqual(ids(result), ['row-invalid'], JSON.stringify(row))
    assert.match(result.findings[0].message, pattern, JSON.stringify(row))
    assert.equal(result.observations.length, 0, JSON.stringify(row))
    assert.equal(result.findings[0].location.pointer, '/rows/0')
  }
})

test('a value of zero is a real observation', () => {
  const result = series({ schemaVersion: '1', metric: 'sessions', rows: [goodRow({ value: 0 })] })
  assert.deepEqual(result.findings, [])
  assert.equal(result.observations[0].value, 0)
})

test('a row is trimmed of surrounding whitespace in its page id', () => {
  const result = series({ schemaVersion: '1', metric: 'sessions', rows: [goodRow({ page: '  /a  ' })] })
  assert.equal(result.observations[0].page, '/a')
})

test('row evidence is bounded even when the row is enormous', () => {
  const result = series({ schemaVersion: '1', metric: 'sessions', rows: [goodRow({ page: 'x'.repeat(5000) })] })
  assert.equal(result.findings[0].evidence.length <= 200, true)
  assert.equal(result.findings[0].message.length <= 400, true)
})

test('the documented row keys are the keys the reader accepts', () => {
  assert.deepEqual([...ROW_KEYS], ['page', 'date', 'value'])
  assert.equal(readRow(goodRow()).ok, true)
  for (const key of ROW_KEYS) {
    const row = goodRow()
    delete row[key]
    assert.equal(readRow(row).ok, false, key)
  }
})

test('a well-formed freshness export yields records and no findings', () => {
  const result = freshness({
    schemaVersion: '1',
    pages: [
      { page: '/a', lastModified: '2025-01-02' },
      { page: '/b', inboundLinks: { baseline: 10, recent: 4 } },
    ],
  })
  assert.deepEqual(result.findings, [])
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].lastModifiedDay > 0, true)
  assert.equal(result.records[0].inboundLinks, null)
  assert.deepEqual(result.records[1].inboundLinks, { baseline: 10, recent: 4 })
})

test('every kind of unusable freshness record is named and dropped', () => {
  const cases = [
    [{ page: '', lastModified: '2025-01-02' }, /non-empty string/u],
    [{ page: '/a', lastModified: '2025-02-30' }, /real calendar date/u],
    [{ page: '/a', lastModifed: '2025-01-02' }, /unknown key "lastModifed"/u],
    [{ page: '/a' }, /describes nothing/u],
    [{ page: '/a', inboundLinks: { baseline: 3 } }, /no inboundLinks.recent/u],
    [{ page: '/a', inboundLinks: { baseline: 3, recent: -1 } }, /zero or more/u],
    [{ page: '/a', inboundLinks: { baseline: 3, recent: 1.5 } }, /zero or more/u],
    [{ page: '/a', inboundLinks: { baseline: 3, recent: 1, other: 2 } }, /unknown inboundLinks key/u],
    [{ page: '/a', inboundLinks: 5 }, /not an object/u],
    [{ page: 'x'.repeat(MAX_PAGE_ID_LENGTH + 1), lastModified: '2025-01-02' }, /over the 256 character bound/u],
  ]
  for (const record of cases) {
    const result = freshness({ schemaVersion: '1', pages: [record[0]] })
    assert.deepEqual(ids(result), ['freshness-record-invalid'], JSON.stringify(record[0]))
    assert.match(result.findings[0].message, record[1], JSON.stringify(record[0]))
    assert.equal(result.records.length, 0)
  }
  assert.deepEqual([...FRESHNESS_RECORD_KEYS], ['page', 'lastModified', 'inboundLinks'])
  assert.equal(readFreshnessRecord({ page: '/a', lastModified: '2025-01-02' }).ok, true)
})

test('an unusable freshness document produces exactly one finding', () => {
  for (const document of [null, 'text', [], { schemaVersion: '2', pages: [] }, { schemaVersion: '1' }, { schemaVersion: '1', page: [] }]) {
    assert.deepEqual(ids(freshness(document)), ['freshness-unparsable'], JSON.stringify(document))
  }
})

test('the freshness record limit is enforced and nothing is read past it', () => {
  const pages = Array.from({ length: 3 }, (unused, index) => ({ page: `/p${index}`, lastModified: '2025-01-02' }))
  const result = freshness({ schemaVersion: '1', pages }, { maxRecords: 2 })
  assert.deepEqual(ids(result), ['freshness-record-limit-exceeded'])
  assert.equal(result.records.length, 0)
  assert.deepEqual(ids(freshness({ schemaVersion: '1', pages }, { maxRecords: 3 })), [])
})
