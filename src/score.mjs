/**
 * Comparing two windows of supplied numbers.
 *
 * Everything this module does is arithmetic over numbers somebody else
 * exported. It can say that the recent window's mean is lower than the
 * baseline window's mean, by how much, and over how many days of data. It
 * cannot say why, it cannot say whether that matters, and it says so.
 *
 * The order of the gates matters and is deliberate:
 *
 *   duplicate observations -> ambiguous, not scored
 *   below minimum volume   -> inconclusive, not scored
 *   below minimum coverage -> inconclusive, not scored
 *   unlike coverage        -> inconclusive, not scored
 *   otherwise              -> scored, and compared
 *
 * Every one of those refusals is an evidence-missing finding, so a run holding
 * one cannot report `pass`. "Too little data" is not "no decline".
 */

import { dayToIso } from './dates.mjs'
import { at, byCodeUnit, makeFinding, msg, pointerForPage } from './rules.mjs'

/** Bounded decimal rendering, independent of locale. */
export function num(value) {
  return String(Number(value.toFixed(4)))
}

function groupByPage(observations, windows) {
  const pages = new Map()
  for (const observation of observations) {
    const which = windows.baseline.included.has(observation.day)
      ? 'baseline'
      : windows.recent.included.has(observation.day)
        ? 'recent'
        : null
    if (which === null) continue
    let entry = pages.get(observation.page)
    if (entry === undefined) {
      entry = { page: observation.page, baseline: new Map(), recent: new Map(), duplicates: [] }
      pages.set(observation.page, entry)
    }
    const bucket = entry[which]
    if (bucket.has(observation.day)) {
      entry.duplicates.push({ day: observation.day, file: observation.file, index: observation.index })
      continue
    }
    bucket.set(observation.day, observation)
  }
  return pages
}

function totals(bucket) {
  let sum = 0
  for (const observation of bucket.values()) sum += observation.value
  return { total: sum, days: bucket.size }
}

/**
 * Score every page the analytics export placed inside the two windows.
 *
 * `freshness` is a Map from page to a deduplicated freshness record. It only
 * ever adds context findings; it never turns an unscored page into a scored
 * one, and it never supplies a reason for a decline.
 */
export function scorePages(observations, freshness, windows, policy) {
  const findings = []
  const grouped = groupByPage(observations, windows)
  const pages = [...grouped.keys()].sort(byCodeUnit)

  let scored = 0
  let inconclusive = 0
  let declining = 0
  let observationCount = 0
  const results = []

  for (const page of pages) {
    const entry = grouped.get(page)
    const baseline = totals(entry.baseline)
    const recent = totals(entry.recent)
    observationCount += baseline.days + recent.days
    const where = at(null, pointerForPage(page))

    if (entry.duplicates.length > 0) {
      const first = entry.duplicates[0]
      findings.push(makeFinding(
        'duplicate-observation',
        msg`${page} has more than one observation for ${dayToIso(first.day)} inside a comparison window, so its totals are ambiguous and it was not scored.`,
        at(first.file, `/rows/${first.index}`),
        {
          evidence: `page=${page} duplicateDays=${entry.duplicates.length}`,
          suggestion: 'Export one row per page per day, then run the comparison again.',
        },
      ))
      inconclusive += 1
      results.push({ page, status: 'ambiguous' })
      continue
    }

    if (baseline.total < policy.minimumVolume || baseline.total <= 0) {
      findings.push(makeFinding(
        'insufficient-volume',
        msg`${page} totals ${num(baseline.total)} ${policy.metric} over the baseline window, under the configured minimum of ${policy.minimumVolume}, so it was not scored. Too little data to compare is inconclusive; it is not an absence of decline.`,
        where,
        {
          evidence: `baselineTotal=${num(baseline.total)} baselineDays=${baseline.days} recentTotal=${num(recent.total)} recentDays=${recent.days}`,
          suggestion: 'Widen the windows, lower minimumVolume deliberately, or accept that this page has too little data to compare.',
        },
      ))
      inconclusive += 1
      results.push({ page, status: 'inconclusive' })
      continue
    }

    if (baseline.days < policy.minimumDays || recent.days < policy.minimumDays) {
      findings.push(makeFinding(
        'insufficient-coverage',
        msg`${page} has ${baseline.days} day(s) of data in the baseline window and ${recent.days} in the recent window, under the configured minimum of ${policy.minimumDays}, so it was not scored.`,
        where,
        {
          evidence: `baselineDays=${baseline.days} recentDays=${recent.days} minimumDays=${policy.minimumDays}`,
          suggestion: 'Export every day in both windows, including days whose value is zero, or lower minimumDays deliberately.',
        },
      ))
      inconclusive += 1
      results.push({ page, status: 'inconclusive' })
      continue
    }

    const gap = Math.abs(baseline.days - recent.days)
    if (gap > policy.maxCoverageGapDays) {
      findings.push(makeFinding(
        'window-coverage-mismatch',
        msg`${page} has ${baseline.days} day(s) of data in the baseline window and ${recent.days} in the recent window, a gap of ${gap} over the configured maximum of ${policy.maxCoverageGapDays}. Windows with unlike coverage are not like for like, so it was not scored.`,
        where,
        {
          evidence: `baselineDays=${baseline.days} recentDays=${recent.days} gap=${gap}`,
          suggestion: 'Export the same days in both windows, or raise maxCoverageGapDays deliberately.',
        },
      ))
      inconclusive += 1
      results.push({ page, status: 'inconclusive' })
      continue
    }

    const baselineMean = baseline.total / baseline.days
    const recentMean = recent.total / recent.days
    const ratio = Number((recentMean / baselineMean).toFixed(4))
    scored += 1
    results.push({ page, status: 'scored', ratio, baselineMean, recentMean })

    const evidence = `baselineMean=${num(baselineMean)} recentMean=${num(recentMean)} ratio=${num(ratio)}`
      + ` baselineDays=${baseline.days} recentDays=${recent.days}`

    if (ratio <= policy.thresholds.decayRatio) {
      declining += 1
      findings.push(makeFinding(
        'decline-over-threshold',
        msg`${page} averaged ${num(recentMean)} ${policy.metric} per day over the recent window against ${num(baselineMean)} over the baseline window, a ratio of ${num(ratio)} at or under the configured ${policy.thresholds.decayRatio}. That is an observed difference between two supplied windows and nothing more.`,
        where,
        {
          evidence,
          suggestion: 'Investigate the page yourself. This tool compared two exported number series and can tell you nothing about why they differ.',
        },
      ))
      continue
    }

    if (ratio <= policy.thresholds.warnRatio) {
      declining += 1
      findings.push(makeFinding(
        'decline-near-threshold',
        msg`${page} averaged ${num(recentMean)} ${policy.metric} per day over the recent window against ${num(baselineMean)} over the baseline window, a ratio of ${num(ratio)} at or under the configured ${policy.thresholds.warnRatio}.`,
        where,
        { evidence, suggestion: 'Watch this page in the next comparison window before acting on one measurement.' },
      ))
    }
  }

  const known = new Set(pages)
  for (const page of [...freshness.keys()].sort(byCodeUnit)) {
    const record = freshness.get(page)
    const where = at(record.file, `/pages/${record.index}`)
    if (!known.has(page)) {
      // Only sayable when every analytics row was actually read. If any export
      // or row was refused, this page might well be in the part that was not
      // read, and reporting it as unknown would be stating a fact the run does
      // not have. The run is already incomplete for that reason; it does not
      // need a second, weaker claim on top.
      if (policy.seriesComplete) {
        findings.push(makeFinding(
          'freshness-page-unknown',
          msg`The freshness export describes ${page}, which no analytics row places inside either comparison window, so nothing was compared for it.`,
          where,
          { suggestion: 'Export analytics rows for this page, or drop it from the freshness export.' },
        ))
      }
      continue
    }
    if (record.lastModifiedDay !== null) {
      const age = windows.recent.endDay - record.lastModifiedDay
      if (age > policy.stalenessDays) {
        findings.push(makeFinding(
          'stale-content',
          msg`${page} was last modified ${dayToIso(record.lastModifiedDay)}, ${age} day(s) before the end of the recent window, over the configured staleness bound of ${policy.stalenessDays}.`,
          where,
          { evidence: `lastModified=${dayToIso(record.lastModifiedDay)} ageDays=${age}`, suggestion: 'Review whether the page still reflects what it describes.' },
        ))
      }
    }
    if (record.inboundLinks !== null) {
      const { baseline: linksBefore, recent: linksAfter } = record.inboundLinks
      if (linksBefore >= policy.thresholds.minimumLinks && linksAfter <= linksBefore * policy.thresholds.linkRatio) {
        findings.push(makeFinding(
          'inbound-link-decline',
          msg`${page} was exported with ${linksAfter} inbound link(s) for the recent window against ${linksBefore} for the baseline window, at or under the configured ratio of ${policy.thresholds.linkRatio}. It is reported next to the metric comparison, not as an account of it.`,
          where,
          {
            evidence: `inboundBaseline=${linksBefore} inboundRecent=${linksAfter}`,
            suggestion: 'Confirm the link export covers the same crawl scope in both windows before drawing any conclusion.',
          },
        ))
      }
    }
  }

  return {
    findings,
    results,
    counts: {
      checked: pages.length,
      scored,
      inconclusive,
      declining,
      observations: observationCount,
    },
  }
}
