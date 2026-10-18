# Contributing

## Getting set up

```sh
bun install
bunx playwright install chromium firefox webkit   # needed by test:browser, test:mobile, test:visual
```

## Before you open a pull request

```sh
bun run check     # types
bun run test      # 18 suites, including the browser suite
```

`bun run test` builds the site as part of `test:browser`, so it covers
`check` → engine → pipeline → integrity → structure → fidelity → text → Unicode
→ visual → browser.

Two suites are deliberately **not** in `bun run test`:

| suite | why not |
| --- | --- |
| `test:mobile` | runs 3 engines × 3 viewports. Run it if you touched layout or touch targets |
| `test:live` | hits the deployed site. Never run it against production casually |

## How this project argues

Most of the engineering here went into making claims checkable. A few
conventions follow from that, and violating them will likely get a change sent
back:

**A test must be able to fail.** Several suites exist only to prove their
subject still detects damage — `test:visual-comparator`, `test:text-extract`,
`test:fidelity-control`, `test:structure-control`. If you change a comparator,
add the case that makes it fail. A comparator that stops detecting leaves every
suite green while proving nothing.

**Measure before optimising.** Several changes here were reverted after being
measured and showing no win. The resize kernel was chosen from a measured table,
not a preference. If you propose a performance change, bring the measurement.

**Prefer running the thing over reading it.** The accessibility defects fixed in
this release were found by writing assertions and watching them fail, not by
reading the markup. An assertion that has never failed proves nothing about
whether it can.

**Do not weaken a threshold to reach green.** Investigate the root cause. If a
threshold looks wrong, say so and change it deliberately, with the reason.

**Document what is untested.** Several sections exist solely to state limits —
that Safari is unverified, that Playwright's WebKit is not Safari, that
accessibility is asserted from the accessibility tree rather than a real screen
reader. Please keep adding to them.

## Commit messages

Describe what changed and, where relevant, why it was wrong before. The history
is written this way deliberately:

```
Refuse a decompression bomb, and fix two silent CMap bugs
Splice image replacements in one pass instead of per image
Make the per-page structure comparison live, and prove it can fail
```

## Checks on a pull request

`.github/workflows/ci.yml` runs on `pull_request` as well as `push`. It is the
gate: nothing merges on assumption.

Two jobs, split by whether a browser is needed. That split was **determined, not
assumed** — `test:fidelity` was run with `PLAYWRIGHT_BROWSERS_PATH` pointed at
an empty directory and still passed 56, so its rasters are fixtures rather than
live renders.

| job | suites | browser |
| --- | --- | --- |
| `verify` | check, engine, pipeline, integrity, structure-control, fidelity, fidelity-control, text-extract, text-integrity, cmap, parser-realism, resource-limits, image-replacements, unicode-integrity, unicode-extraction, visual-comparator | none |
| `browser` | visual, browser, mobile | Chromium / Firefox / WebKit |

`test:live` is deliberately **not** in CI. It fetches the deployed site, so
running it per pull request would mean unrelated changes probing production.
Run it deliberately against a deployment you intend to check.

`deploy.yml` still runs its own 14 checks. That is intentional: it gates its own
publish and should stay fast. The browser-backed suites run here, against every
proposal, rather than once per merge.

## Deploying

Deploys happen automatically on push to `main` and go to Cloudflare Pages. The
workflow verifies 14 suites, asserts the shape of the build output, and then
fetches the live domain to confirm it responds. See `.github/workflows/deploy.yml`.