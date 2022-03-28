# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Two-window comparison of an exported metric, with a configurable minimum
  baseline volume below which a page is reported inconclusive rather than
  scored. That distinction is the point of the tool: sparse data is never "no
  decline".
- Comparability checks decided from the configuration alone, before any export
  is opened: equal window length, equal included days after seasonality
  exclusions, a recent window that begins after the baseline window ends, and
  the positioning the configured seasonality rule demands.
- Seasonality exclusions spelled either as absolute dates or as an `MM-DD`
  calendar position that is removed from every year, so one yearly event comes
  out of both windows at once.
- Optional link and freshness exports, reported as context next to the metric
  comparison and never as an account of it.
- A frozen `ruleId -> severity` catalog of 25 rules, asserted against
  `docs/decay-rules.md` in both directions and against a third hand-written copy
  in the test suite.
- Six configurable limits and five fixed configuration bounds, each enforced and
  each reporting a named finding or a named configuration error rather than
  truncating silently.
- `content-decay-detector` CLI with `--config`, `--root`, `--minimum-volume`,
  `--json` and `--help`, emitting the v1 report envelope on stdout.
- A standing `disclaimer` on every report, whatever the verdict, saying that the
  tool establishes no cause, observes no search ranking or position, and does
  not conclude that anything is wrong.
- Clean and deliberately broken example projects under `examples/`.

### Notes

- Causal and ranking language is refused in code, not only in review. Finding
  messages are built through a tagged template whose literals are checked
  against a frozen `CAUSAL_TERMS` list; the interpolated values, which come from
  untrusted export files, are sanitised instead, so a page genuinely named
  `/why-we-were-penalised` reports normally without the tool appearing to make
  the claim.
- Report status is derived from the findings rather than from a mutable flag,
  and the three rules whose only defence is their evidence-missing marking
  (`insufficient-volume`, `insufficient-coverage`, `window-coverage-mismatch`)
  each have an end-to-end test that fails if that marking is removed.
- `0.1.0` is the version recorded in `package.json`. No release has been
  published.
