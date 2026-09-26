#!/usr/bin/env node

import { checkProject, exitCodeFor, formatSummary, renderReport } from '../src/index.mjs'

const HELP = `content-decay-detector

Compare two windows of an exported metric and report the pages whose recent
window sits far enough below the baseline window to be worth a look. Optional
link and freshness exports are reported alongside the comparison as context.

A page below the configured minimum volume is inconclusive, never "no decline".

Usage:
  content-decay-detector --config FILE [--root DIR] [--minimum-volume N] [--json]

Options:
  --config FILE        Comparison configuration (required)
  --root DIR           Input root that every declared export path resolves
                       against and may not escape, by spelling or through a
                       symbolic link. Defaults to the directory holding the
                       config.
  --minimum-volume N   Override config.minimumVolume: the baseline-window total
                       a page needs before it is scored at all
  --json               Suppress the human summary on stderr
  -h, --help           Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every page with enough data was compared and none declined past the
     configured threshold
  1  the comparison completed and at least one page declined past it
  2  invalid configuration, or evidence the comparison could not obtain. A page
     with too little data is inconclusive and lands here; it is never reported
     as an absence of decline. On a configuration error stdout stays empty; on
     unreadable or insufficient evidence stdout carries an "incomplete" report
     naming what was not established.

This tool never fetches anything. It compares numbers that files inside the
declared input root already contain. It establishes no cause, observes no
search ranking or position, and does not conclude that anything is wrong.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { config: null, root: null, minimumVolume: undefined, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--minimum-volume') {
      const raw = takeValue('--minimum-volume')
      if (!/^\d+$/u.test(raw)) throw new Error('--minimum-volume requires a whole number of 1 or more')
      options.minimumVolume = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.config === null) throw new Error('--config is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await checkProject({
      config: options.config,
      root: options.root ?? undefined,
      minimumVolume: options.minimumVolume,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
