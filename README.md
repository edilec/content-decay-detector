# Content Decay Detector

Compare two comparable windows of an exported metric and report the pages whose
recent window sits far enough below the baseline window to be worth a human
look. Optional link and freshness exports are reported alongside the
comparison, as context.

- **Repository:** [edilec/content-decay-detector](https://github.com/edilec/content-decay-detector)
- **Area:** Content & Publishing
- **License:** MIT

The hard part of a decay check is not the arithmetic. It is refusing to answer
when the data cannot support an answer, and refusing to dress an observation up
as a diagnosis. This tool does three things about that:

- **Below the configured minimum volume, a page is inconclusive.** Not "no
  decline found". The run is `incomplete` and exits 2, so a sparse page can
  never be mistaken for a healthy one.
- **The two windows must be comparable.** Same length, same number of days left
  after seasonality exclusions, and positioned the way the seasonality rule
  requires. A configuration that would compare unlike things is refused before
  any export is opened.
- **It never claims a cause.** It compares numbers somebody else exported. It
  has no view of a search engine, an edit, a redirect or a competitor, so it
  says nothing about ranking, position, penalties or why anything changed. That
  is enforced in code, not just in prose: a frozen `CAUSAL_TERMS` list and a
  tagged template that refuses a finding message containing one.

Nothing is fetched, ever. Every number it reasons about comes from a file
inside a declared input root.

## Install

Node 22 or newer. No runtime dependencies, no dev dependencies, Node built-ins
only.

```sh
npm install content-decay-detector
```

## Use

```sh
npx content-decay-detector --config examples/clean/decay.config.json
npx content-decay-detector --config site/decay.config.json --root site --json
npx content-decay-detector --config site/decay.config.json --minimum-volume 500
```

```
--config FILE        Comparison configuration (required)
--root DIR           Input root every declared export path resolves against and
                     may not escape. Defaults to the directory holding the
                     config.
--minimum-volume N   Override config.minimumVolume
--json               Suppress the human summary on stderr
-h, --help           Show help
```

stdout carries the JSON report and nothing else. stderr carries the human
summary and diagnostics.

| Exit | Meaning |
| ---: | --- |
| `0` | every page with enough data was compared and none declined past the threshold |
| `1` | the comparison completed and at least one page declined past it |
| `2` | invalid configuration, or evidence the comparison could not obtain |

Exit 2 has two shapes. A configuration error means the run never had a subject,
so stdout stays **empty** and the message goes to stderr. Evidence that could
not be read, decoded or scored means the run had a subject and failed to
establish something about it, so stdout carries a report with status
`incomplete` naming what was not established. A consumer piping stdout must
handle an empty stdout on exit 2.

## Configuration

```json
{
  "schemaVersion": "1",
  "metric": "sessions",
  "series": ["exports/analytics.json"],
  "freshness": ["exports/freshness.json"],
  "baseline": { "start": "2024-09-01", "end": "2024-09-30" },
  "recent":   { "start": "2025-09-01", "end": "2025-09-30" },
  "seasonality": {
    "rule": "year-over-year",
    "excludePeriods": [{ "start": "09-14", "end": "09-16" }]
  },
  "minimumVolume": 200,
  "minimumDays": 20,
  "maxCoverageGapDays": 2,
  "stalenessDays": 540,
  "thresholds": { "decayRatio": 0.7, "warnRatio": 0.9, "linkRatio": 0.7, "minimumLinks": 10 }
}
```

Every key is checked. An unknown key, including a one-character typo, is a
configuration error rather than a silently ignored setting.

- `seasonality.rule` is `none`, `adjacent` or `year-over-year`.
- `seasonality.excludePeriods` removes days from **both** windows. Spelled
  `YYYY-MM-DD` it removes those dates; spelled `MM-DD` it removes that calendar
  position in every year, which is how one yearly sale comes out of both
  windows at once.
- `minimumVolume` is the baseline-window total a page needs before it is scored
  at all.
- `minimumDays` and `maxCoverageGapDays` keep the two windows like for like.
- `thresholds.decayRatio` and `warnRatio` are the recent mean as a fraction of
  the baseline mean, at or under which a page is reported.

### Analytics export

```json
{
  "schemaVersion": "1",
  "metric": "sessions",
  "rows": [{ "page": "/guides/install", "date": "2025-09-01", "value": 41 }]
}
```

### Link and freshness export

```json
{
  "schemaVersion": "1",
  "pages": [
    {
      "page": "/guides/install",
      "lastModified": "2025-06-01",
      "inboundLinks": { "baseline": 45, "recent": 44 }
    }
  ]
}
```

Both are JSON. There is no CSV reader; convert your export first. That keeps one
parser, with one set of bounds, instead of two.

## Examples

```sh
node bin/content-decay-detector.mjs --config examples/clean/decay.config.json   # exit 0
node bin/content-decay-detector.mjs --config examples/broken/decay.config.json  # exit 2
```

The broken project shows both halves of the contract in one run: `/guides/install`
falls from about 62 to about 22 a day with 27 days of data in each window and is
flagged as an error, while `/blog/old-post` has 30 sessions across five baseline
days and is reported inconclusive rather than green. Because something was left
unestablished, the run as a whole is `incomplete`.

## Limits and non-goals

This tool reads numbers out of files and compares two windows of them. It
**cannot** conclude:

- **That anything caused the decline.** Not a search engine, not an edit, not a
  redirect, not a competitor, not a season it was not told about. It sees two
  columns of numbers. Any message implying otherwise is a bug, and the code
  refuses to build one.
- **Anything about search ranking or position.** It never sees a search result
  page. The words are not in its vocabulary.
- **That a decline matters.** A page that was always marginal and halved is
  arithmetically identical to a flagship that halved. Deciding which matters is
  your job.
- **That a page is the right unit.** It compares whatever page identifiers your
  export contains. If your export splits one article across three URLs, it
  compares three things.
- **That a flagged page is worse than an unflagged one.** There is no ordering
  of pages by badness here, and `declining` in the summary is a count, not a
  league table.
- **That an unflagged page is healthy.** A page can be below `minimumVolume`, or
  short of `minimumDays`, or absent from the export entirely, or present in the
  export with every row falling outside both comparison windows. The first two
  are reported as inconclusive. The last two are invisible: a page whose rows
  all sit outside the windows is not counted in `summary.checked`, produces no
  finding, and does not stop the run passing, however steeply its numbers moved
  outside them. Only rows inside the two windows are compared.
- **That a missing day means zero.** A date absent from the export is treated as
  no observation. If a page fell to literal zero and your export omits zero
  rows, this tool sees a coverage gap and says it cannot judge. Export zero rows
  explicitly if you want zeros counted.
- **That the two windows are truly comparable in the world.** It checks that
  they are the same length, keep the same days, and sit where the seasonality
  rule says. It cannot know that one of them contained an outage, a campaign, or
  a tracking change. `seasonality.excludePeriods` exists for the ones you know
  about; it cannot help with the ones you do not.
- **That your export is accurate.** Sampling, bot filtering, consent-gated
  analytics and tag changes are all invisible to it.
- **Anything at all when it could not read something.** An unreadable export, an
  undecodable one, an exceeded limit, a malformed row: each is reported, and
  each makes the run `incomplete` rather than passing on what was left. Numbers
  in an incomplete report describe the rows that were read, not the export.

It also never writes anything, never fetches anything, and refuses any
configured path that leaves the input root, by spelling or through a symbolic
link.

## Determinism

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by UTF-16 code unit; `localeCompare` is never used. No wall clock is
read — the only "now" the tool has is the end of the recent window, which the
configuration supplies. Two runs over identical inputs produce byte-identical
stdout.

## Verify

```sh
npm run check
```

`check` runs the linter, the test suite, the clean example, and a packaging dry
run. The suite covers the public API and the real CLI.

The guarantees stated here and in [`docs/decay-rules.md`](./docs/decay-rules.md)
are meant to be defended by tests that fail when the guarantee is taken out of
the source, and the defences are checked by mutation rather than by reading
them: the guarantee is removed, the suite is run, and a defence that stays green
is not a defence. That is a method, not a proof that nothing was missed -- a
round of it found a guard that agreed with itself three ways and noticed
nothing.

The guarantees that decide a verdict are pinned by what a run emits, not by one
declaration agreeing with another. `test/severity.test.mjs` drives every rule in
the catalog through the real CLI and checks the emitted severity, the status and
the exit code against hand-written expectations, so a coordinated edit of the
severity table, the documentation and the test catalog cannot hide a downgrade.
`test/ordering.test.mjs` asserts the exact order of a real report over inputs
that code units and collation order differently, so substituting a collating
comparator fails it even though the source carries no `localeCompare`.
`test/boundaries.test.mjs` pins both sides of twenty documented limits, against
the 22 mutations that tighten each comparison by one.

## Documentation

- [`docs/decay-rules.md`](./docs/decay-rules.md) — the rule catalog, every
  severity, every limit, the comparability rules, and the boundaries.
- [`CHANGELOG.md`](./CHANGELOG.md) — release notes.

## License

MIT. See [LICENSE](./LICENSE).
