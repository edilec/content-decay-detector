/**
 * content-decay-detector
 *
 * Read historical analytics exports and optional link/freshness exports, then
 * compare two windows of the same metric and report the pages whose recent
 * window sits far enough below the baseline window to be worth a human's
 * attention.
 *
 * Three rules govern the whole design, and they matter more than the
 * arithmetic:
 *
 * 1. Below the configured minimum volume, a page is *inconclusive*. It is never
 *    reported as "no decline". A run holding one inconclusive page is
 *    `incomplete` and exits 2.
 * 2. The two windows must be comparable -- equal length, equal included days
 *    after seasonality exclusions, and positioned the way the seasonality rule
 *    requires. A configuration that cannot compare like with like is refused
 *    before a single export is opened.
 * 3. This tool observes a difference between numbers somebody else exported. It
 *    cannot establish cause, it never sees a search result, and it does not
 *    conclude that anything is wrong. Finding messages are checked against a
 *    frozen list of causal and ranking words at construction time.
 *
 * Nothing is fetched. Every export it reads comes from a file inside a declared
 * input root that the configuration cannot escape, by spelling or through a
 * symbolic link.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { SEASONALITY_RULES, buildWindow, comparabilityProblems, parseIsoDate, parseMonthDay } from './dates.mjs'
import { scanFreshness } from './freshness.mjs'
import {
  EVIDENCE_MISSING_RULES,
  LINE_SEPARATORS,
  RULE_IDS,
  RULE_SEVERITY,
  at,
  byCodeUnit,
  makeFinding,
  marksEvidenceMissing,
  msg,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'
import { scorePages } from './score.mjs'
import { scanSeries } from './series.mjs'

export { SEASONALITY_RULES, buildWindow, comparabilityProblems, dayToIso, parseIsoDate, parseMonthDay } from './dates.mjs'
export { FRESHNESS_KEYS, FRESHNESS_RECORD_KEYS, readFreshnessRecord, scanFreshness } from './freshness.mjs'
export {
  CAUSAL_TERMS,
  EVIDENCE_LIMIT,
  EVIDENCE_MISSING_RULES,
  LINE_SEPARATORS,
  MAX_PAGE_ID_LENGTH,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  SafeMessage,
  assertNoCausalClaim,
  at,
  byCodeUnit,
  compareFindings,
  findCausalClaim,
  makeFinding,
  marksEvidenceMissing,
  msg,
  pointerForPage,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'
export { num, scorePages } from './score.mjs'
export { ROW_KEYS, SERIES_KEYS, readRow, scanSeries } from './series.mjs'

export const TOOL_ID = 'content-decay-detector'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

/**
 * Printed in every report, whatever the verdict.
 *
 * It is a top-level string rather than a finding because it is true of the run
 * as a whole, and because the words it needs are exactly the words a finding
 * message is forbidden to use.
 */
export const DISCLAIMER =
  'This report compares two windows of numbers supplied to it. A flagged page is an observed decline in '
  + 'those numbers, not a diagnosis: this tool establishes no cause, observes no search ranking or position, '
  + 'and does not conclude that anything is wrong.'

/** Every limit here is enforced; exceeding one is reported, never truncated. */
export const DEFAULT_LIMITS = Object.freeze({
  maxFreshnessBytes: 4000000,
  maxFreshnessRecords: 50000,
  maxPages: 20000,
  maxRows: 200000,
  maxSeriesBytes: 8000000,
  maxWindowDays: 400,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS).sort(byCodeUnit))

/** Bounds on the configuration document itself. Exceeding one is a ConfigError. */
export const MAX_CONFIG_BYTES = 1000000
export const MAX_INPUT_FILES = 64
export const MAX_EXCLUDE_PERIODS = 64
export const MAX_METRIC_LENGTH = 64

export const DEFAULT_POLICY = Object.freeze({
  minimumVolume: 100,
  minimumDays: 20,
  maxCoverageGapDays: 3,
  stalenessDays: 540,
  thresholds: Object.freeze({ decayRatio: 0.7, warnRatio: 0.9, linkRatio: 0.7, minimumLinks: 10 }),
})

const CONFIG_KEYS = Object.freeze([
  'schemaVersion', 'metric', 'series', 'freshness', 'baseline', 'recent', 'seasonality',
  'minimumVolume', 'minimumDays', 'maxCoverageGapDays', 'stalenessDays', 'thresholds', 'limits',
])
const WINDOW_KEYS = Object.freeze(['start', 'end'])
const SEASONALITY_KEYS = Object.freeze(['rule', 'excludePeriods'])
const PERIOD_KEYS = Object.freeze(['start', 'end'])
const THRESHOLD_KEYS = Object.freeze(['decayRatio', 'warnRatio', 'linkRatio', 'minimumLinks'])

/** A problem with the configuration itself, not with the content being read. */
export class ConfigError extends Error {
  constructor(message, rule = null) {
    super(message)
    this.name = 'ConfigError'
    this.rule = rule
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function escapes(from, target) {
  const rel = relative(from, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * The real path a target has once every symbolic link on the way to it is
 * followed.
 *
 * `realpath` needs the whole path to exist, but an export that was never
 * produced must still reach the report as `series-unreadable` rather than as a
 * configuration error. So the deepest existing ancestor is resolved for real
 * and the missing segments are appended literally: a link anywhere along the
 * part that does exist is still followed.
 */
async function realPathOf(target, describe) {
  const tail = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : resolve(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new ConfigError(
          `${describe} could not be resolved (${error.code ?? 'unknown error'})`,
          'input-unresolvable',
        )
      }
      const parent = dirname(current)
      if (parent === current) return target
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve a configured input path, refusing to leave the declared root.
 *
 * The lexical check is not the boundary. A symbolic link planted inside the
 * root points wherever it likes, and following one would read a file the
 * configuration never had the right to name. So the path is confined again
 * after every link on it has been followed, against the *real* path of the
 * root -- the root may itself sit behind a link, as `/var` does on macOS, and
 * refusing a file that is genuinely inside the root is a bug too.
 */
export async function resolveWithin(root, realRoot, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty relative path`, 'input-not-relative')
  }
  if (isAbsolute(candidate)) {
    throw new ConfigError(
      `${label} must be relative to the input root, but "${sanitize(candidate, 120)}" is absolute`,
      'input-not-relative',
    )
  }
  const resolved = resolve(root, candidate)
  if (escapes(root, resolved)) {
    throw new ConfigError(
      `${label} resolves outside the input root: "${sanitize(candidate, 120)}"`,
      'input-outside-root',
    )
  }
  const real = await realPathOf(resolved, `${label} ("${sanitize(candidate, 120)}")`)
  if (escapes(realRoot, real)) {
    throw new ConfigError(
      `${label} leaves the input root through a symbolic link: "${sanitize(candidate, 120)}". Nothing was read from it.`,
      'input-escapes-root',
    )
  }
  return resolved
}

function requirePositiveInteger(value, label, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigError(`${label} must be an integer of ${minimum} or more`)
  }
  return value
}

function requireRatio(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigError(`${label} must be a number greater than 0 and at most 1`)
  }
  return value
}

function requireKnownKeys(object, known, label) {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      throw new ConfigError(`Unknown key "${sanitize(key, 60)}" in ${label}. Known keys: ${known.join(', ')}`)
    }
  }
}

function readWindowSpec(value, label) {
  if (!isRecord(value)) throw new ConfigError(`${label} must be an object with "start" and "end"`)
  requireKnownKeys(value, WINDOW_KEYS, label)
  const start = parseIsoDate(value.start)
  if (!start.ok) throw new ConfigError(`${label}.start ${start.reason}`)
  const end = parseIsoDate(value.end)
  if (!end.ok) throw new ConfigError(`${label}.end ${end.reason}`)
  if (end.day < start.day) throw new ConfigError(`${label}.end is before ${label}.start`)
  return { startDay: start.day, endDay: end.day }
}

function readExcludePeriods(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError('seasonality.excludePeriods must be an array')
  if (value.length > MAX_EXCLUDE_PERIODS) {
    throw new ConfigError(`seasonality.excludePeriods holds ${value.length} periods, over the bound of ${MAX_EXCLUDE_PERIODS}`)
  }
  return value.map((entry, index) => {
    const label = `seasonality.excludePeriods[${index}]`
    if (!isRecord(entry)) throw new ConfigError(`${label} must be an object with "start" and "end"`)
    requireKnownKeys(entry, PERIOD_KEYS, label)
    const absoluteStart = parseIsoDate(entry.start)
    const absoluteEnd = parseIsoDate(entry.end)
    if (absoluteStart.ok && absoluteEnd.ok) {
      if (absoluteEnd.day < absoluteStart.day) throw new ConfigError(`${label}.end is before ${label}.start`)
      return { kind: 'absolute', startDay: absoluteStart.day, endDay: absoluteEnd.day }
    }
    const recurringStart = parseMonthDay(entry.start)
    const recurringEnd = parseMonthDay(entry.end)
    if (recurringStart.ok && recurringEnd.ok) {
      if (recurringEnd.key < recurringStart.key) {
        throw new ConfigError(
          `${label}.end is before ${label}.start. A period that wraps the year end is two periods.`,
        )
      }
      return { kind: 'recurring', startKey: recurringStart.key, endKey: recurringEnd.key }
    }
    throw new ConfigError(
      `${label} must spell both bounds the same way: YYYY-MM-DD for one period, or MM-DD for that period in every year`,
    )
  })
}

function readPathList(value, label, required) {
  if (value === undefined) {
    if (required) throw new ConfigError(`${label} must name at least one export file`)
    return []
  }
  if (!Array.isArray(value)) throw new ConfigError(`${label} must be an array of relative paths`)
  if (required && value.length === 0) throw new ConfigError(`${label} must name at least one export file`)
  if (value.length > MAX_INPUT_FILES) {
    throw new ConfigError(`${label} names ${value.length} files, over the bound of ${MAX_INPUT_FILES}`)
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`${label} must hold non-empty relative path strings`)
    }
  }
  return [...value]
}

/**
 * Validate the configuration and build the two comparison windows.
 *
 * Everything decidable from the configuration alone is decided here, before any
 * export is opened: an unknown key, an impossible date, a threshold out of
 * range, and above all two windows that cannot be compared. Those are
 * configuration errors -- the run never had a subject -- so they leave stdout
 * empty and exit 2.
 */
export function validateConfig(document, overrides = {}) {
  if (!isRecord(document)) throw new ConfigError('Config must be a JSON object')
  requireKnownKeys(document, CONFIG_KEYS, 'the config')
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(
      `Unsupported config schemaVersion: ${document.schemaVersion === undefined ? 'missing' : sanitize(document.schemaVersion, 40)}`,
    )
  }

  if (typeof document.metric !== 'string' || document.metric.trim() === '') {
    throw new ConfigError('metric must name the measure being compared, for example "sessions"')
  }
  if (document.metric.length > MAX_METRIC_LENGTH) {
    throw new ConfigError(`metric must be at most ${MAX_METRIC_LENGTH} characters`)
  }
  const metric = document.metric.trim()

  const series = readPathList(document.series, 'series', true)
  const freshness = readPathList(document.freshness, 'freshness', false)

  const limits = { ...DEFAULT_LIMITS }
  if (document.limits !== undefined) {
    if (!isRecord(document.limits)) throw new ConfigError('limits must be an object')
    for (const [name, value] of Object.entries(document.limits)) {
      if (!LIMIT_NAMES.includes(name)) {
        throw new ConfigError(`Unknown limit "${sanitize(name, 60)}". Known limits: ${LIMIT_NAMES.join(', ')}`)
      }
      limits[name] = requirePositiveInteger(value, `limits.${name}`)
    }
  }

  const seasonalitySource = document.seasonality ?? {}
  if (!isRecord(seasonalitySource)) throw new ConfigError('seasonality must be an object')
  requireKnownKeys(seasonalitySource, SEASONALITY_KEYS, 'seasonality')
  const rule = seasonalitySource.rule ?? 'none'
  if (!SEASONALITY_RULES.includes(rule)) {
    throw new ConfigError(
      `seasonality.rule must be one of ${SEASONALITY_RULES.join(', ')}, got "${sanitize(rule, 40)}"`,
    )
  }
  const excludePeriods = readExcludePeriods(seasonalitySource.excludePeriods)

  const baselineSpec = readWindowSpec(document.baseline, 'baseline')
  const recentSpec = readWindowSpec(document.recent, 'recent')
  for (const [label, spec] of [['baseline', baselineSpec], ['recent', recentSpec]]) {
    const span = spec.endDay - spec.startDay + 1
    if (span > limits.maxWindowDays) {
      throw new ConfigError(
        `the ${label} window spans ${span} days, over limits.maxWindowDays of ${limits.maxWindowDays}`,
      )
    }
  }
  const baseline = buildWindow(baselineSpec.startDay, baselineSpec.endDay, excludePeriods)
  const recent = buildWindow(recentSpec.startDay, recentSpec.endDay, excludePeriods)
  const problems = comparabilityProblems(baseline, recent, rule)
  if (problems.length > 0) {
    throw new ConfigError(`The two windows are not comparable: ${problems.join('; ')}.`, 'windows-not-comparable')
  }

  const thresholdSource = document.thresholds ?? {}
  if (!isRecord(thresholdSource)) throw new ConfigError('thresholds must be an object')
  requireKnownKeys(thresholdSource, THRESHOLD_KEYS, 'thresholds')
  const thresholds = {
    decayRatio: requireRatio(thresholdSource.decayRatio ?? DEFAULT_POLICY.thresholds.decayRatio, 'thresholds.decayRatio'),
    warnRatio: requireRatio(thresholdSource.warnRatio ?? DEFAULT_POLICY.thresholds.warnRatio, 'thresholds.warnRatio'),
    linkRatio: requireRatio(thresholdSource.linkRatio ?? DEFAULT_POLICY.thresholds.linkRatio, 'thresholds.linkRatio'),
    minimumLinks: requirePositiveInteger(
      thresholdSource.minimumLinks ?? DEFAULT_POLICY.thresholds.minimumLinks,
      'thresholds.minimumLinks',
    ),
  }
  if (thresholds.decayRatio > thresholds.warnRatio) {
    throw new ConfigError('thresholds.decayRatio must be at most thresholds.warnRatio')
  }

  const minimumVolume = requirePositiveInteger(
    overrides.minimumVolume ?? document.minimumVolume ?? DEFAULT_POLICY.minimumVolume,
    'minimumVolume',
  )
  const minimumDays = requirePositiveInteger(document.minimumDays ?? DEFAULT_POLICY.minimumDays, 'minimumDays')
  if (minimumDays > baseline.includedDays) {
    throw new ConfigError(
      `minimumDays is ${minimumDays} but each window keeps only ${baseline.includedDays} day(s) after exclusions, `
      + 'so no page could ever be scored',
    )
  }
  const maxCoverageGapDays = requirePositiveInteger(
    document.maxCoverageGapDays ?? DEFAULT_POLICY.maxCoverageGapDays,
    'maxCoverageGapDays',
    0,
  )
  const stalenessDays = requirePositiveInteger(document.stalenessDays ?? DEFAULT_POLICY.stalenessDays, 'stalenessDays')

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    metric,
    series,
    freshness,
    seasonality: { rule, excludePeriods },
    windows: { baseline, recent },
    policy: { metric, minimumVolume, minimumDays, maxCoverageGapDays, stalenessDays, thresholds },
    limits,
  }
}

/**
 * Read a file as UTF-8, strictly.
 *
 * `fatal: true` is the whole point: a file whose bytes are not UTF-8 is
 * reported as undecodable, and encoding validity is never inferred from the
 * decoded text. A document that legitimately contains U+FFFD is evidence of
 * nothing. This is the only read path in the tool -- the configuration goes
 * through it too, because a config path that quietly accepts broken bytes is
 * the same defect one directory over.
 *
 * `ignoreBOM` is left at its default of false, which is what removes a leading
 * byte order mark, so an export saved by a tool that writes one parses. There
 * is deliberately no second strip after this: a file starting with two byte
 * order marks is malformed, and refusing it as unparsable is the honest answer.
 */
export async function readTextBounded(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file', text: null }
  if (info.size > maxBytes) {
    return { status: 'too-large', reason: `${info.size} bytes exceeds the ${maxBytes} byte limit`, text: null }
  }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { status: 'not-utf8', reason: 'the bytes are not valid UTF-8', text: null }
  }
  return { status: 'ok', reason: null, text }
}

const READ_LABELS = Object.freeze({ series: 'analytics', freshness: 'freshness' })

const READ_RULES = Object.freeze({
  series: { unreadable: 'series-unreadable', tooLarge: 'series-too-large', notUtf8: 'series-not-utf8', unparsable: 'series-unparsable' },
  freshness: { unreadable: 'freshness-unreadable', tooLarge: 'freshness-too-large', notUtf8: 'freshness-not-utf8', unparsable: 'freshness-unparsable' },
})

/**
 * Read and JSON-parse one export, reporting anything that stopped it.
 *
 * A failure here always produces a finding whose rule is evidence-missing, so
 * an export that was not read can never be mistaken for an export that held
 * nothing.
 */
async function loadDocument(kind, absolute, file, maxBytes, findings) {
  const rules = READ_RULES[kind]
  const label = READ_LABELS[kind]
  const read = await readTextBounded(absolute, maxBytes)
  if (read.status === 'unreadable') {
    findings.push(makeFinding(rules.unreadable, msg`The ${label} export could not be read (${read.reason}).`, at(file, null), {
      suggestion: 'Produce the export before running the comparison, or correct the path in the config.',
    }))
    return null
  }
  if (read.status === 'too-large') {
    findings.push(makeFinding(rules.tooLarge, msg`The ${label} export was not read: ${read.reason}.`, at(file, null), {
      suggestion: `Raise limits.max${kind === 'series' ? 'Series' : 'Freshness'}Bytes deliberately, or split the export.`,
    }))
    return null
  }
  if (read.status === 'not-utf8') {
    findings.push(makeFinding(rules.notUtf8, msg`The ${label} export was not decoded: ${read.reason}.`, at(file, null), {
      suggestion: 'Write the export as UTF-8.',
    }))
    return null
  }
  try {
    return JSON.parse(read.text)
  } catch (error) {
    findings.push(makeFinding(rules.unparsable, msg`The ${label} export is not valid JSON: ${error.message}.`, at(file, null), {
      suggestion: 'Correct the JSON. Nothing was read from this file.',
    }))
    return null
  }
}

export function buildReport(findings, counts) {
  const sorted = sortFindings(findings)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(sorted),
    disclaimer: DISCLAIMER,
    summary: {
      checked: counts.checked,
      errors: sorted.filter((finding) => finding.severity === 'error').length,
      warnings: sorted.filter((finding) => finding.severity === 'warning').length,
      info: sorted.filter((finding) => finding.severity === 'info').length,
      scored: counts.scored,
      inconclusive: counts.inconclusive,
      declining: counts.declining,
      observations: counts.observations,
    },
    findings: sorted,
  }
}

const EMPTY_COUNTS = Object.freeze({ checked: 0, scored: 0, inconclusive: 0, declining: 0, observations: 0 })

/**
 * Run one comparison.
 *
 * Throws `ConfigError` when the run never had a subject. Everything that went
 * wrong with the evidence itself comes back inside the report.
 */
export async function checkProject({ config, root, minimumVolume }) {
  const configPath = resolve(process.cwd(), config)
  const configRead = await readTextBounded(configPath, MAX_CONFIG_BYTES)
  if (configRead.status !== 'ok') {
    throw new ConfigError(`Could not load the config: ${configRead.reason}`)
  }
  let document
  try {
    document = JSON.parse(configRead.text)
  } catch (error) {
    // The parser quotes a slice of the document it choked on, so the config
    // file's own bytes reach stderr through this message. Every other untrusted
    // string is sanitised where it is built; this one has no finding to be
    // built into, so it is sanitised here.
    throw new ConfigError(`The config is not valid JSON: ${sanitize(error.message, 200)}`)
  }
  const validated = validateConfig(document, { minimumVolume })

  const inputRoot = root === undefined || root === null ? dirname(configPath) : resolve(process.cwd(), root)
  let realRoot
  try {
    realRoot = await realpath(inputRoot)
  } catch (error) {
    throw new ConfigError(`The input root could not be resolved (${error.code ?? 'unknown error'})`, 'input-unresolvable')
  }

  const findings = []
  const observations = []
  const pageIds = new Set()

  for (const [index, declared] of validated.series.entries()) {
    const absolute = await resolveWithin(inputRoot, realRoot, declared, `series[${index}]`)
    const file = sanitize(toPosix(relative(inputRoot, absolute)), 512)
    const parsed = await loadDocument('series', absolute, file, validated.limits.maxSeriesBytes, findings)
    if (parsed === null) continue
    const scan = scanSeries(parsed, { file, metric: validated.metric, maxRows: validated.limits.maxRows })
    findings.push(...scan.findings)
    for (const observation of scan.observations) {
      observations.push(observation)
      pageIds.add(observation.page)
    }
  }

  /**
   * Whether the analytics side of the run is whole.
   *
   * Every way a row or an export can be refused is an evidence-missing rule, so
   * this is exact at this point: if it is false, some analytics row was not
   * read, and nothing downstream may claim to know what is absent from the
   * data.
   */
  const seriesComplete = !findings.some((finding) => marksEvidenceMissing(finding.ruleId))

  const freshnessByPage = new Map()
  for (const [index, declared] of validated.freshness.entries()) {
    const absolute = await resolveWithin(inputRoot, realRoot, declared, `freshness[${index}]`)
    const file = sanitize(toPosix(relative(inputRoot, absolute)), 512)
    const parsed = await loadDocument('freshness', absolute, file, validated.limits.maxFreshnessBytes, findings)
    if (parsed === null) continue
    const scan = scanFreshness(parsed, { file, maxRecords: validated.limits.maxFreshnessRecords })
    findings.push(...scan.findings)
    for (const record of scan.records) {
      const existing = freshnessByPage.get(record.page)
      if (existing !== undefined) {
        findings.push(makeFinding(
          'freshness-duplicate-page',
          msg`The freshness exports describe ${record.page} more than once, so its freshness is ambiguous and none of it was used.`,
          at(record.file, `/pages/${record.index}`),
          {
            evidence: `first=${existing.file} duplicate=${record.file}`,
            suggestion: 'Describe each page once across all freshness exports.',
          },
        ))
        freshnessByPage.set(record.page, { ...existing, ambiguous: true })
        continue
      }
      freshnessByPage.set(record.page, { ...record, ambiguous: false })
    }
  }
  for (const [page, record] of freshnessByPage) {
    if (record.ambiguous) freshnessByPage.delete(page)
  }

  if (pageIds.size > validated.limits.maxPages) {
    findings.push(makeFinding(
      'page-limit-exceeded',
      msg`The analytics exports describe ${pageIds.size} pages, over the limit of ${validated.limits.maxPages}; none of them were scored.`,
      at(null, '/series'),
      { suggestion: 'Raise limits.maxPages deliberately, or compare fewer pages at a time.' },
    ))
    return buildReport(findings, EMPTY_COUNTS)
  }

  const scored = scorePages(observations, freshnessByPage, validated.windows, { ...validated.policy, seriesComplete })
  findings.push(...scored.findings)

  if (scored.counts.scored === 0 && !findings.some((finding) => marksEvidenceMissing(finding.ruleId))) {
    findings.push(makeFinding(
      'no-pages-scored',
      msg`No page was scored, so there is no evidence to pass or fail on.`,
      at(null, '/series'),
      { suggestion: 'Supply analytics rows that fall inside both comparison windows.' },
    ))
  }

  return buildReport(findings, scored.counts)
}

const SEPARATOR_PATTERN = new RegExp(`[${LINE_SEPARATORS}]`, 'gu')
const SEPARATOR_ESCAPES = new Map(
  [...LINE_SEPARATORS].map((character) => [
    character,
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  ]),
)

/**
 * Serialise the report for stdout.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 raw, and inside a JavaScript string
 * literal those two are line terminators. The payload parses as JSON either
 * way, but a page identifier carrying one would break a consumer that evaluates
 * the payload as JavaScript, so both are escaped here.
 */
export function renderReport(report) {
  const json = JSON.stringify(report, null, 2)
  return `${json.replace(SEPARATOR_PATTERN, (character) => SEPARATOR_ESCAPES.get(character))}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.location.file, finding.location.pointer].filter(Boolean).map((part) => sanitize(part, 200)).join(' ')
    return `${finding.severity.toUpperCase().padEnd(7)} ${sanitize(finding.ruleId, 40).padEnd(31)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.checked} page(s) seen, ${report.summary.scored} scored, `
    + `${report.summary.inconclusive} inconclusive, ${report.summary.declining} declining, `
    + `${report.summary.observations} observation(s).`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info. `
    + `Status ${report.status}.`,
  )
  lines.push(report.disclaimer)
  return `${lines.join('\n')}\n`
}

/** Exported so the rule catalog and the limits can be asserted against the docs. */
export const CATALOG = Object.freeze({
  ruleIds: RULE_IDS,
  severity: RULE_SEVERITY,
  evidenceMissing: EVIDENCE_MISSING_RULES,
  limits: DEFAULT_LIMITS,
  limitNames: LIMIT_NAMES,
  policy: DEFAULT_POLICY,
  severityFor,
})
