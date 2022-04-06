# Rule catalog, limits and boundaries

Every rule id below is stable across releases. Renaming one is a breaking change
and is recorded in the changelog.

## What this tool is entitled to say

It reads numbers out of files you give it, compares two windows of them, and
reports where the recent window is lower. That is the whole of it.

It has no view of a search engine, a competitor, a redirect, an edit, a
campaign, or a season it was not told about. So it does not say that a decline
was caused by anything, it does not mention search ranking or position, and it
does not conclude that a page is bad. Those words are not a style preference:
`src/rules.mjs` holds a frozen `CAUSAL_TERMS` list and every finding message is
built through a tagged template that refuses a literal containing one. The
report also carries a standing `disclaimer` string saying the same thing, on
every run, whatever the verdict.

## Severity decides the exit code

Severity is declared once, in `RULE_SEVERITY` in `src/rules.mjs`, and every
finding takes its severity from that table. A finding built with an unknown rule
id throws. The table in this document is asserted against the code in both
directions by `test/rules.test.mjs`.

That cross-check alone is not the defence, because editing this file and the
code together satisfies it. `test/rules.test.mjs` therefore carries a third,
hand-written copy of the catalog and asserts the status every rule alone
produces, `test/honesty.test.mjs` runs real projects for each rule whose only
defence is its evidence-missing marking and asserts the status and exit code
they yield, and `test/project.test.mjs` reaches every read and limit rule
through the filesystem. A downgrade has to get past all of them.

- any `error` finding, and no missing evidence, means **fail** and exit 1
- `warning` and `info` findings alone mean **pass** and exit 0
- any rule marked *evidence missing* means **incomplete** and exit 2, whatever
  its own severity is

The last row is the one that carries this tool. `insufficient-volume`,
`insufficient-coverage` and `window-coverage-mismatch` are all `warning`
severity, so for those three the evidence-missing marking is the *only* thing
between a page the tool could not judge and a green run. A page with too little
data is inconclusive. It is never an absence of decline.

Report status is computed from the findings themselves rather than from a
separate flag, so there is no single assignment whose removal would turn an
unscored page into a green build.

## Rules

| Rule | Severity | Evidence missing | What it reports |
| --- | --- | --- | --- |
| `decline-near-threshold` | warning | no | A scored page's recent-window mean is at or under `thresholds.warnRatio` of its baseline-window mean. |
| `decline-over-threshold` | error | no | A scored page's recent-window mean is at or under `thresholds.decayRatio` of its baseline-window mean. |
| `duplicate-observation` | error | yes | A page has more than one row for one date inside a comparison window, so its totals are ambiguous. The page is not scored. |
| `freshness-duplicate-page` | error | yes | The freshness exports describe one page more than once. None of that page's freshness is used. |
| `freshness-not-utf8` | error | yes | A freshness export could not be decoded as UTF-8. |
| `freshness-page-unknown` | info | no | A freshness record names a page no analytics row places inside either window, so nothing was compared for it. Withheld whenever any analytics export or row was refused, because the page could be in the part that was not read. |
| `freshness-record-invalid` | error | yes | A freshness record has an unknown key, an unusable date, an unusable link count, or describes nothing. The record is not read. |
| `freshness-record-limit-exceeded` | error | yes | A freshness export holds more records than `maxFreshnessRecords`. None are read. |
| `freshness-too-large` | error | yes | A freshness export is larger than `maxFreshnessBytes`. |
| `freshness-unparsable` | error | yes | A freshness export is not JSON, has an unknown key, declares the wrong `schemaVersion`, or has no `pages` array. |
| `freshness-unreadable` | error | yes | A freshness export could not be read. |
| `inbound-link-decline` | warning | no | A page's exported inbound link count for the recent window is at or under `thresholds.linkRatio` of its baseline count, with at least `thresholds.minimumLinks` to begin with. Reported next to the metric comparison, never as an account of it. |
| `insufficient-coverage` | warning | yes | A page has fewer days of data than `minimumDays` in one of the windows. It is not scored. |
| `insufficient-volume` | warning | yes | A page's baseline-window total is under `minimumVolume`. It is not scored, and the answer for it is inconclusive. |
| `metric-mismatch` | error | yes | An analytics export measures a different metric than the configuration compares. None of its rows are used. |
| `no-pages-scored` | error | yes | No page was scored and nothing else explained why, so there is no evidence to pass or fail on. |
| `page-limit-exceeded` | error | yes | The analytics exports describe more pages than `maxPages`. None are scored. |
| `row-invalid` | error | yes | An analytics row has an unknown key, a missing key, an unusable page id, an unusable date, or a value that is not a finite number of zero or more. The row is not read. |
| `row-limit-exceeded` | error | yes | An analytics export holds more rows than `maxRows`. None are read. |
| `series-not-utf8` | error | yes | An analytics export could not be decoded as UTF-8. |
| `series-too-large` | error | yes | An analytics export is larger than `maxSeriesBytes`. |
| `series-unparsable` | error | yes | An analytics export is not JSON, has an unknown key, declares the wrong `schemaVersion`, names no metric, or has no `rows` array. |
| `series-unreadable` | error | yes | An analytics export could not be read. |
| `stale-content` | info | no | A page's exported `lastModified` is more than `stalenessDays` before the end of the recent window. |
| `window-coverage-mismatch` | warning | yes | A page's two windows differ in observed days by more than `maxCoverageGapDays`, so they are not like for like. It is not scored. |

`no-pages-scored` is the guard against a vacuous pass: a run that scored nothing
is `incomplete`, never `pass` with `scored: 0`. It is emitted only when no other
evidence-missing finding already explains the absence, so an unreadable export
or an exceeded limit is reported once rather than twice.

## Configurable limits

Each limit is a positive integer in `config.limits`. An unknown limit name is a
configuration error, not a silently ignored key. Exceeding a limit produces the
finding named below and marks the run incomplete; it never truncates silently.

| Limit | Default | Exceeding it reports |
| --- | ---: | --- |
| `maxFreshnessBytes` | 4000000 | `freshness-too-large` |
| `maxFreshnessRecords` | 50000 | `freshness-record-limit-exceeded` |
| `maxPages` | 20000 | `page-limit-exceeded` |
| `maxRows` | 200000 | `row-limit-exceeded` |
| `maxSeriesBytes` | 8000000 | `series-too-large` |
| `maxWindowDays` | 400 | a configuration error, described below |

`maxWindowDays` is the one exception to the row above it. It bounds the
*configuration*, not the evidence: a window longer than it means the run never
had a valid subject, so stdout stays empty and the process exits 2 instead of
carrying an incomplete report. Every other limit in the table is exceeded by
something inside a file, which is evidence the run could not obtain, so it is
reported as a finding and the run is incomplete.

## Bounds that are not configurable

These bound the configuration document itself. Exceeding one is a configuration
error with an empty stdout, because nothing was read.

| Bound | Value | What it limits |
| --- | ---: | --- |
| `MAX_CONFIG_BYTES` | 1000000 | The size of the configuration file. |
| `MAX_INPUT_FILES` | 64 | Entries in `series` and in `freshness`, each. |
| `MAX_EXCLUDE_PERIODS` | 64 | Entries in `seasonality.excludePeriods`. |
| `MAX_METRIC_LENGTH` | 64 | Characters in `metric`. |
| `MAX_PAGE_ID_LENGTH` | 256 | Characters in a page identifier, in either export. |

## Comparability, and the seasonality rules

Two windows are comparable only if all of this holds, and all of it is decided
from the configuration alone, before any export is opened:

- they span the same number of days;
- after seasonality exclusions they keep the same number of days;
- at least one day survives;
- the recent window begins after the baseline window ends;
- and whatever `seasonality.rule` demands:

| `seasonality.rule` | Demands |
| --- | --- |
| `none` | Nothing beyond the shared requirements above. |
| `adjacent` | The recent window begins the day after the baseline window ends. |
| `year-over-year` | Both windows begin on the same month and day. |

A February 29 in one window and not the other makes the two spans differ by a
day, which is refused rather than quietly absorbed. Shorten one window by a day
if you want the comparison anyway; that is a decision for you to record, not for
this tool to make silently.

`seasonality.excludePeriods` removes days from **both** windows. An entry
spelled `YYYY-MM-DD` removes exactly those dates; an entry spelled `MM-DD`
removes that calendar position in every year, which is how one yearly sale or
one yearly outage is taken out of both windows at once. An exclusion that lands
inside only one window changes its included-day count and is therefore refused.
A period that wraps the year end is two periods.

## What a missing day means

A date absent from the analytics export is treated as **no observation**, not as
a zero. Means are per observed day, and `minimumDays` and `maxCoverageGapDays`
exist so that two windows with very different coverage are never compared.

This is the honest reading of an export, and it has a cost worth stating: if a
page fell to literal zero and your export omits zero rows, this tool sees a
coverage gap rather than a collapse, and reports the page as inconclusive. Export
zero rows explicitly if you want zeros counted as zeros.

## Every number in a finding is a number that was read

Totals, means and day counts describe the rows the tool actually accepted. If a
row was refused, the page's numbers are computed without it, and the run is
`incomplete` for that reason — so a per-page figure in an incomplete report is a
figure over partial data, not over the export. The same reasoning is why
`freshness-page-unknown` is withheld when any analytics row was refused: to say
a page appears nowhere in the data, the tool would have to have read all of it.

## Determinism

- Findings sort by `(location.file, location.pointer, ruleId, message)`, each
  compared by UTF-16 code unit. `localeCompare` is never used: it depends on ICU
  data that differs between Node builds, and it has already produced a real
  ordering difference in this catalog.
- No wall clock is read. The only "now" the tool has is the end of the recent
  window, which the configuration supplies, and `stale-content` is measured
  against that.
- Running the tool twice over identical inputs produces byte-identical stdout.
- U+2028 and U+2029 never reach stdout raw. Both are legal raw in JSON and are
  line terminators inside a JavaScript string literal, so a payload carrying one
  parses as JSON and breaks a consumer that evaluates it. There are two
  defences: `sanitize` strips both out of every untrusted string before it
  reaches a finding, and the serialiser escapes both again on the way out, so a
  field added later that forgets the first defence still cannot emit one.

## Boundaries

- Nothing is fetched. There is no network code in this tool at all.
- Every declared export path is resolved to its real path and confined to the
  real path of the input root. Both sides are resolved, so a symbolic link out
  of the root is refused and a file genuinely inside a root that is itself
  reached through a link is still read.
- Nothing is written. The tool reads its inputs and prints a report.
- Input content is data. Every untrusted string that reaches the report or the
  human summary is flattened first -- a page identifier, an export path, a
  configuration key, an export key, an evidence excerpt, and the parser's own
  complaint about a document it could not read. Removed: C0 `U+0000`-`U+001F`,
  `DEL` `U+007F`, C1 `U+0080`-`U+009F`, `U+2028`, `U+2029`, and every Unicode
  format character (`\p{Cf}`), which is what takes out the bidi controls
  `U+200E`, `U+200F`, `U+202A`-`U+202E` and the isolates `U+2066`-`U+2069`.
  C1 matters as much as C0: `U+0085` is a line break and `U+009B` is an 8-bit
  CSI, so either forges a line in a terminal or a CI log. So an identifier
  carrying a newline cannot forge a line in the summary, one carrying `U+202E`
  cannot reverse what is displayed next to it, and one carrying a causal claim
  cannot make this tool appear to have made it.
