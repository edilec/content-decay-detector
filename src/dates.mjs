/**
 * Calendar arithmetic, comparison windows, and the seasonality rules that
 * decide whether two windows are comparable at all.
 *
 * Everything here works in whole UTC days represented as integers counted from
 * 1970-01-01. No local time zone, no locale, no wall clock: the only "now" this
 * tool has is the end of the recent window, which the configuration supplies.
 */

const DAY_MS = 86400000

export const MIN_YEAR = 1000
export const MAX_WINDOW_DAYS_CEILING = 3660

/** The seasonality rules that decide how the two windows must be positioned. */
export const SEASONALITY_RULES = Object.freeze(['none', 'adjacent', 'year-over-year'])

const MONTH_LENGTHS = Object.freeze([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

/**
 * Parse a `YYYY-MM-DD` calendar date.
 *
 * The round trip through `Date` is what rejects 2025-02-30 and 2025-13-01: the
 * constructor happily rolls those over, so the only way to know the input named
 * a real day is to format the result back and compare.
 */
export function parseIsoDate(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'must be a string in YYYY-MM-DD form' }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return { ok: false, reason: 'must be in YYYY-MM-DD form' }
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const date = Number(value.slice(8, 10))
  if (year < MIN_YEAR) return { ok: false, reason: `year must be ${MIN_YEAR} or later` }
  const ms = Date.UTC(year, month - 1, date)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== date) {
    return { ok: false, reason: 'is not a real calendar date' }
  }
  return { ok: true, day: ms / DAY_MS, year, month, date }
}

/** Parse a recurring `MM-DD` calendar position, used for annual exclusions. */
export function parseMonthDay(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'must be a string in MM-DD form' }
  if (!/^\d{2}-\d{2}$/u.test(value)) return { ok: false, reason: 'must be in MM-DD form' }
  const month = Number(value.slice(0, 2))
  const date = Number(value.slice(3, 5))
  if (month < 1 || month > 12) return { ok: false, reason: 'names no month' }
  if (date < 1 || date > MONTH_LENGTHS[month - 1]) return { ok: false, reason: 'names no day of that month' }
  return { ok: true, key: month * 100 + date, month, date }
}

export function dayToIso(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

export function monthDayKeyOf(day) {
  const when = new Date(day * DAY_MS)
  return (when.getUTCMonth() + 1) * 100 + when.getUTCDate()
}

/**
 * Turn a validated exclusion period into a predicate over day numbers.
 *
 * A period spelled with full dates excludes exactly those days. A period
 * spelled `MM-DD` excludes that calendar position in every year, which is how a
 * yearly sale or a yearly outage is taken out of both windows at once.
 */
export function excluderFor(period) {
  if (period.kind === 'absolute') {
    return (day) => day >= period.startDay && day <= period.endDay
  }
  return (day) => {
    const key = monthDayKeyOf(day)
    return key >= period.startKey && key <= period.endKey
  }
}

/**
 * Build one comparison window: its bounds, and the set of days inside it that
 * no exclusion period removed.
 *
 * The included set is materialised because the score needs a per-day membership
 * test and because the two windows' included counts have to be compared. Window
 * length is bounded by the caller, so the set is bounded too.
 */
export function buildWindow(startDay, endDay, periods) {
  const excluders = periods.map(excluderFor)
  const included = new Set()
  const excluded = []
  for (let day = startDay; day <= endDay; day += 1) {
    if (excluders.some((matches) => matches(day))) excluded.push(day)
    else included.add(day)
  }
  return {
    startDay,
    endDay,
    start: dayToIso(startDay),
    end: dayToIso(endDay),
    length: endDay - startDay + 1,
    included,
    includedDays: included.size,
    excludedDays: excluded.length,
  }
}

/**
 * Decide whether the two windows may be compared at all.
 *
 * Returns a list of reasons, empty when they are comparable. Every reason is
 * derived from the configuration alone -- no export file has been opened yet --
 * so the caller reports these as a configuration error rather than as a
 * finding about the site.
 */
export function comparabilityProblems(baseline, recent, rule) {
  const problems = []
  if (baseline.length !== recent.length) {
    problems.push(
      `the baseline window spans ${baseline.length} day(s) and the recent window spans ${recent.length}; `
      + 'two windows of different length are not comparable',
    )
  }
  if (baseline.includedDays !== recent.includedDays) {
    problems.push(
      `after seasonality exclusions the baseline window keeps ${baseline.includedDays} day(s) and the recent `
      + `window keeps ${recent.includedDays}; an exclusion that lands in only one window breaks the comparison`,
    )
  }
  if (baseline.includedDays === 0) {
    problems.push('seasonality exclusions removed every day of both windows, leaving nothing to compare')
  }
  if (recent.startDay <= baseline.endDay) {
    problems.push('the recent window must begin after the baseline window ends')
  }
  if (rule === 'adjacent' && recent.startDay !== baseline.endDay + 1) {
    problems.push(
      `the "adjacent" seasonality rule requires the recent window to begin the day after the baseline window `
      + `ends: expected ${dayToIso(baseline.endDay + 1)}, got ${recent.start}`,
    )
  }
  if (rule === 'year-over-year') {
    const from = new Date(baseline.startDay * DAY_MS)
    const to = new Date(recent.startDay * DAY_MS)
    if (from.getUTCMonth() !== to.getUTCMonth() || from.getUTCDate() !== to.getUTCDate()) {
      problems.push(
        'the "year-over-year" seasonality rule requires both windows to begin on the same month and day: '
        + `${baseline.start} and ${recent.start} do not`,
      )
    }
  }
  return problems
}
