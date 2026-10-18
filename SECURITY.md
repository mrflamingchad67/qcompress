# Security Policy

## Reporting

Report a vulnerability privately through
[GitHub Security Advisories](https://github.com/mrflamingchad67/qcompress/security/advisories/new).

Please do not open a public issue for a suspected vulnerability.

## Threat model

QCompress is a **static site**. It has no server component, no account system,
no analytics, and no telemetry. It is deployed to Cloudflare Pages as static
files.

The compressor runs entirely in the visitor's browser. A PDF is read with the
File API, passed to QPDF compiled to WebAssembly inside a Web Worker, and written
out as a Blob. **The file is never uploaded.** The browser suite asserts this
directly: it records every network request the page makes and fails if the PDF
bytes appear in any of them.

This is the property worth attacking, so it is worth being precise about what it
does and does not cover:

- It covers the *steady state* — once the page has loaded, processing a PDF
  makes no further requests.
- It does not cover the page's own asset loads, which necessarily exist.
- A modified build could exfiltrate. The assertion is about the shipped code,
  not about arbitrary code someone might inject.

## What is trusted, and what is not

**The PDF is untrusted input.** It may be hostile: this is a parser, and parsers
are the classic attack surface. Specific defences already in place:

- Inflate output is capped at 128 MB per stream. Flate expands by roughly
  1032:1, and an unbounded inflate allocated the entire decoded payload before
  any check could run — a 100 KB stream produced 100 MB and +156 MB of heap. That
  is an allocation failure rather than a catchable error, so it took the worker
  down instead of rejecting one candidate.
- The cap **throws** rather than truncating. A truncated stream would yield a
  corrupt PDF that still looked structurally valid.
- Every candidate produced is checked for structural validity before it can be
  offered. A file that cannot be shown to be safe is not offered.
- Parsing runs in a Worker, so a hang or a crash does not take the page with it.

**Browser extensions and the user's own machine** are outside this project's
control and outside this threat model.

## Signature behaviour

Rewriting a PDF invalidates any digital signature it carried. This is
unavoidable — any change to bytes breaks the signature — and QCompress says so
on the result panel rather than presenting a signed-looking file as signed.

This is stated, not enforced: the app does not attempt to detect or preserve
signatures.

## Cryptographic signing

None. There is no signature on the deployed site beyond TLS, and no subresource
integrity on the WebAssembly module — it is fetched from the same origin as the
code that runs it, so a compromise of the origin compromises both.

## Supported versions

| version | supported |
| --- | --- |
| 1.0.0 | ✅ |

## A note on dependencies

The build depends on `@sveltejs/kit`, `vite` and a set of `@jsquash` image
codecs. The vendored QPDF WebAssembly build is checked in rather than fetched at
runtime, so the engine cannot change underneath a deployed page. Keep that
property: anything fetched at runtime is something the origin no longer controls.