# Changelog

All notable changes to QCompress.

The project has not been formally versioned before 1.0.0, so this file is
reconstructed from the commit history rather than maintained alongside it.
Entries are grouped by what a user would notice, not by internal stage.

## 1.0.0

First tagged release.

### Privacy and UX

- Errors now lead with plain language and keep the engine's own diagnostic as
  the reason. QPDF reports failures against a scratch filename
  (`in_<random>_0.pdf`) that exists only inside the WebAssembly filesystem; the
  user saw a name they had never heard of, presented as though it were theirs.
  The scratch name is replaced with the file actually chosen.
- Compression progress is announced through a polite live region that reports
  changing text, not one static string.
- Failures are announced assertively through `role="alert"`.
- The alert is focusable (`tabindex="-1"`) and receives focus when it appears.
  Previously focus fell to `document.body`.
- Completion is announced. The progress panel lives inside `{#if busy}` and is
  destroyed the moment compression ends, so the whole operation previously
  finished in silence — measured at zero announcements across a complete run.
  A separate, permanently mounted live region now reports the result.
- `prefers-reduced-motion: reduce` removes the busy spinner instead of slowing
  it. It previously ran at a reduced speed, which is still a rotation.
- Primary and secondary controls and the mode chips meet a 44 px minimum touch
  target; two were found short at phone sizes.
- Colour tokens meet WCAG AA in both themes on both the success and error paths.

### Correctness

- An inflate bomb is refused. Flate expands by roughly 1032:1, and a stream with
  no ceiling allocated the entire decoded payload before any check could run —
  a 100 KB stream produced 100 MB and +156 MB of heap, and QPDF accepted the
  file. That is an allocation failure rather than a catchable error, so it took
  the worker down instead of rejecting one candidate.
- Two silent bugs in the Unicode layer are fixed: an un-awaited async codec whose
  promise was stringified, and `Buffer.from(latin1)` re-encoding bytes ≥ 0x80
  as UTF-8.
- `parseObjects` no longer loses objects whose body is a bare string or array.
  It searched forward for the next `<<`, and on a real 10-page file lost 80 of
  197 objects including all 16 of its `/ToUnicode` maps.
- Semantic structure comparison is live in every mode rather than Lossless only.
  It had been dead code: an early return made the entire per-page block
  unreachable, so annotations, link targets and page geometry were never
  compared.
- Images are spliced in one pass instead of rebuilding the document per image,
  which allocated ~191 MB on a 33-image file. Output is byte-identical.

### Performance

- The resize kernel was changed after measuring all four. The default was
  silently inheriting `lanczos3` + `premultiply` + `linearRGB`, none of which
  was ever chosen. On a 32-page book: 26,497 ms → 18,245 ms (31 % faster) and
  1,531,324 B → 1,437,194 B (6.1 % smaller), byte-identical across five runs.
  `premultiply` is off for a structural reason: every pixel came from a JPEG
  decoder, which always yields alpha 255, so premultiplying it is the identity.

### Verification

- The browser suite runs in Chromium, Firefox and WebKit and each engine must
  pass: 92 assertions each, 276 total.
- Phone sizes are tested at three viewports across all three engines.
- Suites that verify a comparator can actually fail were added alongside the
  comparators, so a detector that stops detecting cannot leave the suite green
  while proving nothing.
- The corpus gained fixtures derived from real documents, so parser paths are
  reachable rather than absent.

### Deployment

- Build and deploy run in one job. The previous two-job arrangement shipped a
  `build/build/...` artifact, and wrangler uploaded a single directory instead
  of the site. Every deploy reported success and published nothing usable, while
  the CDN served cached copies of the last good deployment.
- The workflow asserts on the shape of what is about to be published, and
  fetches the production domain afterwards to confirm it responds.

### Known gaps at 1.0.0

- Safari is unverified. Playwright's WebKit is not Safari.
- No browser version floor has been tested against; see the README.
- Accessibility is asserted by reading the accessibility tree and live-region
  text. No real screen reader has been run against it.