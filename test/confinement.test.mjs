import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigError, checkProject, resolveWithin } from '../src/index.mjs'
import { configJson, pageRows, runCli, seriesJson } from './helpers.mjs'

const SECRET = 'TOP-SECRET-CONTENT-THAT-MUST-NEVER-REACH-A-REPORT'

/**
 * A site directory with a sibling directory outside it. The outside directory
 * holds documents the configuration has no right to name -- one of them a
 * perfectly valid analytics export, so a tool that followed the link would
 * produce a plausible report out of content it was never given.
 */
async function makeSite(t, { series = ['exports/analytics.json'], freshness = [] } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'content-decay-confinement-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const site = join(parent, 'site')
  const outside = join(parent, 'outside')
  await mkdir(join(site, 'exports'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.json'), seriesJson({ rows: pageRows(`/${SECRET}`, 60, 20) }))
  await writeFile(join(outside, 'secret.txt'), `${SECRET}\n`)
  await writeFile(join(site, 'exports', 'analytics.json'), seriesJson({ rows: pageRows('/guides/install', 40, 41) }))
  await writeFile(join(site, 'decay.config.json'), configJson({ series, freshness }))
  return { parent, site, outside, config: join(site, 'decay.config.json') }
}

async function refusal(t, options) {
  const site = await makeSite(t, options)
  const error = await checkProject({ config: site.config }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true, 'expected a ConfigError')
  assert.equal(error.message.includes(SECRET), false, 'the refusal echoed out-of-root content')
  return { site, error }
}

test('a lexical escape from the input root is refused', async (t) => {
  const { error } = await refusal(t, { series: ['../outside/secret.json'] })
  assert.equal(error.rule, 'input-outside-root')
})

test('an absolute input path is refused', async (t) => {
  const { error } = await refusal(t, { series: ['/etc/hosts'] })
  assert.equal(error.rule, 'input-not-relative')
})

test('a symbolic link to a file outside the root is refused after resolution', async (t) => {
  const site = await makeSite(t, { series: ['exports/linked.json'] })
  await symlink(join(site.outside, 'secret.json'), join(site.site, 'exports', 'linked.json'))

  const error = await checkProject({ config: site.config }).then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.equal(error.rule, 'input-escapes-root')
  assert.equal(error.message.includes(SECRET), false)

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '', 'a configuration refusal must leave stdout empty')
  assert.equal(run.stderr.includes(SECRET), false)
  assert.match(run.stderr, /symbolic link/u)
})

test('a symbolic link to a directory outside the root is refused after resolution', async (t) => {
  const site = await makeSite(t, { series: ['exports/away/secret.json'] })
  await symlink(site.outside, join(site.site, 'exports', 'away'))

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.includes(SECRET), false)
  assert.match(run.stderr, /input root/u)
})

test('a freshness path may not leave the root through a link either', async (t) => {
  const site = await makeSite(t, { freshness: ['linked-freshness.json'] })
  await symlink(join(site.outside, 'secret.txt'), join(site.site, 'linked-freshness.json'))

  const run = await runCli(['--config', site.config])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.includes(SECRET), false)
})

test('a relative path that stays inside the root is allowed', async (t) => {
  const site = await makeSite(t, { series: ['exports/../exports/analytics.json'] })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.scored, 1)
})

test('a root that is itself reached through a symbolic link still works', async (t) => {
  // Both sides have to be resolved. Comparing a realpath'd root against a
  // non-realpath'd target refuses files that are genuinely inside the root,
  // which is a bug of its own.
  const site = await makeSite(t)
  const linkedRoot = join(site.parent, 'linked-site')
  await symlink(site.site, linkedRoot)

  const report = await checkProject({ config: join(linkedRoot, 'decay.config.json'), root: linkedRoot })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.scored, 1)
})

test('a file inside the root reached through an inside-the-root link is allowed', async (t) => {
  const site = await makeSite(t, { series: ['exports/alias.json'] })
  await symlink(join(site.site, 'exports', 'analytics.json'), join(site.site, 'exports', 'alias.json'))
  const report = await checkProject({ config: site.config })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.scored, 1)
})

test('an input root that does not exist is a configuration error', async (t) => {
  const site = await makeSite(t)
  const error = await checkProject({ config: site.config, root: join(site.parent, 'absent') })
    .then(() => null, (thrown) => thrown)
  assert.equal(error instanceof ConfigError, true)
  assert.equal(error.rule, 'input-unresolvable')
})

test('an empty or non-string input path is refused before anything is opened', async (t) => {
  const site = await makeSite(t)
  const real = await realpath(site.site)
  for (const candidate of ['   ', '', null, 42]) {
    const error = await resolveWithin(site.site, real, candidate, 'series[0]')
      .then(() => null, (thrown) => thrown)
    assert.equal(error instanceof ConfigError, true, JSON.stringify(candidate))
    assert.equal(error.rule, 'input-not-relative')
  }
  const blank = await makeSite(t, { series: ['  '] })
  await assert.rejects(() => checkProject({ config: blank.config }), /non-empty relative path strings/u)
})

test('an export that is missing inside the root is a finding, not a refusal', async (t) => {
  // The confinement layer must not turn "you never produced this export" into
  // a configuration error: the report has to say which file was not read.
  const site = await makeSite(t, { series: ['exports/never-written.json'] })
  const report = await checkProject({ config: site.config })
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['series-unreadable'])
  assert.equal(report.findings[0].location.file, 'exports/never-written.json')
  assert.equal(report.status, 'incomplete')
})
