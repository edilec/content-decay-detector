import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SEASONALITY_RULES,
  buildWindow,
  comparabilityProblems,
  dayToIso,
  parseIsoDate,
  parseMonthDay,
} from '../src/index.mjs'

const window = (start, end, periods = []) => {
  const from = parseIsoDate(start)
  const to = parseIsoDate(end)
  assert.equal(from.ok && to.ok, true, `${start}..${end} must be real dates`)
  return buildWindow(from.day, to.day, periods)
}

test('a calendar date is accepted only when it names a real day', () => {
  const ok = parseIsoDate('2025-09-01')
  assert.equal(ok.ok, true)
  assert.equal(dayToIso(ok.day), '2025-09-01')
  assert.equal(parseIsoDate('2024-02-29').ok, true, 'a leap day is a real day')

  for (const [value, fragment] of [
    ['2025-02-30', 'real calendar date'],
    ['2025-13-01', 'real calendar date'],
    ['2023-02-29', 'real calendar date'],
    ['2025-9-01', 'YYYY-MM-DD'],
    ['20250901', 'YYYY-MM-DD'],
    ['0025-01-01', '1000 or later'],
    [20250901, 'must be a string'],
    [null, 'must be a string'],
  ]) {
    const parsed = parseIsoDate(value)
    assert.equal(parsed.ok, false, `${String(value)} must be refused`)
    assert.match(parsed.reason, new RegExp(fragment, 'u'), String(value))
  }
})

test('day numbers are consecutive integers and round trip through ISO', () => {
  const first = parseIsoDate('2024-12-30')
  const second = parseIsoDate('2024-12-31')
  const third = parseIsoDate('2025-01-01')
  assert.equal(second.day - first.day, 1)
  assert.equal(third.day - second.day, 1)
  assert.equal(dayToIso(third.day), '2025-01-01')
})

test('a recurring MM-DD position is validated against real months', () => {
  assert.equal(parseMonthDay('11-25').key, 1125)
  assert.equal(parseMonthDay('02-29').ok, true, 'February 29 exists in some years')
  assert.equal(parseMonthDay('02-30').ok, false)
  assert.equal(parseMonthDay('13-01').ok, false)
  assert.equal(parseMonthDay('1-1').ok, false)
  assert.equal(parseMonthDay('2025-01-01').ok, false)
})

test('an absolute exclusion removes exactly the days it names', () => {
  const start = parseIsoDate('2025-09-10').day
  const end = parseIsoDate('2025-09-12').day
  const built = window('2025-09-01', '2025-09-30', [{ kind: 'absolute', startDay: start, endDay: end }])
  assert.equal(built.length, 30)
  assert.equal(built.excludedDays, 3)
  assert.equal(built.includedDays, 27)
  assert.equal(built.included.has(parseIsoDate('2025-09-11').day), false)
  assert.equal(built.included.has(parseIsoDate('2025-09-13').day), true)
})

test('a recurring exclusion removes the same calendar days in every year', () => {
  const period = { kind: 'recurring', startKey: 914, endKey: 916 }
  const baseline = window('2024-09-01', '2024-09-30', [period])
  const recent = window('2025-09-01', '2025-09-30', [period])
  assert.equal(baseline.includedDays, 27)
  assert.equal(recent.includedDays, 27)
  assert.equal(baseline.included.has(parseIsoDate('2024-09-15').day), false)
  assert.equal(recent.included.has(parseIsoDate('2025-09-15').day), false)
  assert.equal(recent.included.has(parseIsoDate('2025-09-17').day), true)
})

test('windows of different length are not comparable', () => {
  const problems = comparabilityProblems(window('2024-09-01', '2024-09-30'), window('2025-09-01', '2025-09-29'), 'none')
  assert.equal(problems.length > 0, true)
  assert.match(problems[0], /different length/u)
})

test('a leap day in only one window is refused rather than absorbed', () => {
  const baseline = window('2024-02-01', '2024-03-01')
  const recent = window('2025-02-01', '2025-03-01')
  assert.equal(baseline.length, 30)
  assert.equal(recent.length, 29)
  assert.match(comparabilityProblems(baseline, recent, 'year-over-year').join(' '), /different length/u)
})

test('an exclusion landing in only one window is not comparable', () => {
  const period = { kind: 'absolute', startDay: parseIsoDate('2025-09-10').day, endDay: parseIsoDate('2025-09-12').day }
  const baseline = window('2024-09-01', '2024-09-30', [period])
  const recent = window('2025-09-01', '2025-09-30', [period])
  assert.equal(baseline.includedDays, 30)
  assert.equal(recent.includedDays, 27)
  assert.match(comparabilityProblems(baseline, recent, 'year-over-year').join(' '), /only one window/u)
})

test('exclusions that remove every day leave nothing to compare', () => {
  const period = { kind: 'recurring', startKey: 901, endKey: 930 }
  const baseline = window('2024-09-01', '2024-09-30', [period])
  const recent = window('2025-09-01', '2025-09-30', [period])
  assert.equal(baseline.includedDays, 0)
  assert.match(comparabilityProblems(baseline, recent, 'none').join(' '), /removed every day/u)
})

test('the year-over-year rule demands the same month and day', () => {
  const aligned = comparabilityProblems(window('2024-09-01', '2024-09-30'), window('2025-09-01', '2025-09-30'), 'year-over-year')
  assert.deepEqual(aligned, [])
  const shifted = comparabilityProblems(window('2024-09-01', '2024-09-30'), window('2025-10-01', '2025-10-30'), 'year-over-year')
  assert.match(shifted.join(' '), /same month and day/u)
  assert.deepEqual(
    comparabilityProblems(window('2024-09-01', '2024-09-30'), window('2025-10-01', '2025-10-30'), 'none'),
    [],
    'the same pair is fine when no seasonality rule is configured',
  )
})

test('the adjacent rule demands the recent window start the next day', () => {
  const touching = comparabilityProblems(window('2025-07-01', '2025-07-30'), window('2025-07-31', '2025-08-29'), 'adjacent')
  assert.deepEqual(touching, [])
  const gapped = comparabilityProblems(window('2025-07-01', '2025-07-30'), window('2025-08-05', '2025-09-03'), 'adjacent')
  assert.match(gapped.join(' '), /the day after/u)
})

test('the recent window may not begin before the baseline window ends', () => {
  const overlapping = comparabilityProblems(window('2025-09-01', '2025-09-30'), window('2025-09-15', '2025-10-14'), 'none')
  assert.match(overlapping.join(' '), /must begin after/u)
})

test('the seasonality rules are exactly the three documented ones', () => {
  assert.deepEqual([...SEASONALITY_RULES], ['none', 'adjacent', 'year-over-year'])
})
