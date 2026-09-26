/** Shared fixture builders. This file defines no tests. */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = fileURLToPath(new URL('..', import.meta.url))
export const BIN = fileURLToPath(new URL('../bin/content-decay-detector.mjs', import.meta.url))

/** The two windows every fixture compares: the same 30 days, one year apart. */
export const BASELINE = Object.freeze({ start: '2024-09-01', end: '2024-09-30' })
export const RECENT = Object.freeze({ start: '2025-09-01', end: '2025-09-30' })

const DAY_MS = 86400000

/** `count` consecutive ISO dates starting at `start`. */
export function daysFrom(start, count) {
  const first = Date.parse(`${start}T00:00:00Z`) / DAY_MS
  return Array.from({ length: count }, (unused, index) => new Date((first + index) * DAY_MS).toISOString().slice(0, 10))
}

/** One row per day. `value` is a number or a function of the day index. */
export function rowsFor(page, start, count, value) {
  return daysFrom(start, count).map((date, index) => ({
    page,
    date,
    value: typeof value === 'function' ? value(index) : value,
  }))
}

/** Rows for both windows at once: a flat baseline level and a flat recent level. */
export function pageRows(page, baselineValue, recentValue, { days = 30 } = {}) {
  return [
    ...rowsFor(page, BASELINE.start, days, baselineValue),
    ...rowsFor(page, RECENT.start, days, recentValue),
  ]
}

export function seriesJson({ metric = 'sessions', rows = [], schemaVersion = '1', extra = {} } = {}) {
  return `${JSON.stringify({ schemaVersion, metric, rows, ...extra }, null, 2)}\n`
}

export function freshnessJson(pages, { schemaVersion = '1', extra = {} } = {}) {
  return `${JSON.stringify({ schemaVersion, pages, ...extra }, null, 2)}\n`
}

export function baseConfig(overrides = {}) {
  return {
    schemaVersion: '1',
    metric: 'sessions',
    series: ['exports/analytics.json'],
    baseline: { ...BASELINE },
    recent: { ...RECENT },
    seasonality: { rule: 'year-over-year' },
    minimumVolume: 200,
    minimumDays: 20,
    maxCoverageGapDays: 2,
    ...overrides,
  }
}

export function configJson(overrides = {}) {
  return `${JSON.stringify(baseConfig(overrides), null, 2)}\n`
}

/**
 * Write a throwaway project under the system temp directory and return its
 * root. `files` maps a relative path to a string or a Buffer, so a fixture can
 * plant bytes that are deliberately not UTF-8.
 */
export async function makeProject(files) {
  const root = await mkdtemp(join(tmpdir(), 'content-decay-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

export async function removeProject(root) {
  await rm(root, { recursive: true, force: true })
}

/**
 * The common project shape: one config, one analytics export, optionally one
 * freshness export. Returns the root and the path of the config inside it.
 */
export async function project(t, { rows = [], freshness = null, config = {}, files = {} } = {}) {
  const contents = {
    'decay.config.json': configJson(freshness === null ? config : { freshness: ['exports/freshness.json'], ...config }),
    'exports/analytics.json': seriesJson({ metric: config.metric ?? 'sessions', rows }),
    ...(freshness === null ? {} : { 'exports/freshness.json': freshnessJson(freshness) }),
    ...files,
  }
  const root = await makeProject(contents)
  t.after(() => removeProject(root))
  return { root, config: join(root, 'decay.config.json') }
}

export function runCli(args, options = {}) {
  return new Promise((settle) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      {
        cwd: options.cwd ?? REPO,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      },
      (error, stdout, stderr) => {
        settle({ code: error === null ? 0 : error.code, killed: error !== null && error.killed === true, stdout, stderr })
      },
    )
  })
}

/** The (ruleId, file, pointer) triples of a report, in report order. */
export function triples(report) {
  return report.findings.map((finding) => [
    finding.ruleId,
    finding.location.file ?? null,
    finding.location.pointer ?? null,
  ])
}

export function ruleIdsOf(report) {
  return report.findings.map((finding) => finding.ruleId)
}
