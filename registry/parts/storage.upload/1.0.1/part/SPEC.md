# storage.upload — SPEC

Presigned, direct-to-storage uploads and downloads for any S3-compatible
provider, via in-part AWS Signature Version 4. v1 scope is **single-PUT upload
and GET download**, signing only the `host` header.

## Design decisions

- **Presigning is pure computation — zero network, zero dependencies.** The
  part turns credentials + a key into a signed URL using `node:crypto` and
  nothing else; the browser performs the actual transfer. So importing does no
  I/O, there is no transport error to handle, and the whole part is provable
  offline and deterministically.
- **No adapters — S3 is one wire format.** AWS S3, Cloudflare R2, MinIO,
  Backblaze B2, DigitalOcean Spaces, and Wasabi all speak SigV4 over the S3
  REST API; the differences (endpoint, region, path-style vs virtual-hosted)
  are *configuration*, not code. So the part ships zero adapters and a single
  `default` attestation, configured by env (like the email part, minus the
  adapter axis).
- **Conformance is anchored to AWS's own implementation.** The hard part of
  SigV4 is getting the canonicalization byte-exact. Rather than trust a
  hand-read of the spec, the suite pins known-answer vectors captured from the
  AWS CLI (botocore) and asserts the part reproduces each signed URL
  character-for-character — across path-style, virtual-hosted, non-default
  ports, multiple regions, and keys with spaces/Unicode. The PUT path (the CLI
  presigns GET only) is checked against an independent in-suite reimplementation
  that the same vectors prove correct.
- **`host`-only signing in v1.** Signing extra headers (content-type) or
  enforcing size limits is the job of POST-policy uploads, a different and
  larger mechanism. v1 deliberately signs only `host` so every output stays
  anchored to a botocore vector; content-type/size enforcement is roadmap.
- **Server-assigned everything sensitive.** Credentials never leave the server;
  the access key id (public) appears in the URL credential, the secret never
  does. `expiresAt` and `X-Amz-Expires` come from the signer, not the caller's
  clock.
- **Bounded, validated inputs.** Expiry is clamped to the SigV4 maximum of 7
  days; keys are length- and control-char-checked. Out-of-range inputs fail
  fast with typed errors and produce no URL.

## Invariant → conformance test mapping

| # | Invariant (contract.json) | Test (conformance/presign.test.ts) |
|---|---|---|
| 1 | No import I/O; config validated at call time, typed errors | "invariant 1: missing config is a typed error at call time" |
| 2 | Signatures byte-identical to AWS (botocore), both addressing modes | "invariant 2: …" (4 vectors + PUT via reference) |
| 3 | Required X-Amz-* params, scope, host, signed headers, method | "invariant 3: …" (path + virtual-hosted) |
| 4 | Signature binds key/method/expiry/region/secret | "invariant 4: the signature binds the whole request" |
| 5 | Key encoding (space/unicode) + rejection of bad keys | "invariant 5: …" |
| 6 | Bounded expiry reflected in URL + expiresAt | "invariant 6: bounded expiry" |
| 7 | Secret never in URL/error; typed StorageError | "invariant 7: the secret never appears…" |

The golden vectors live in `conformance/vectors.ts` with the exact AWS CLI
command to regenerate them.

## Threat model

- **Credential exposure.** The secret access key is read lazily from server
  env, never placed in a URL or header (only the public access key id is), and
  scrubbed from every error message. Presigning client-side would leak it — the
  seams doc forbids it and the flow keeps signing on the server.
- **Presigned-URL misuse.** A presigned URL is a bearer capability for exactly
  one object, method, and expiry window — the signature binds all of them, so
  it cannot be edited to reach another key or switch GET→PUT (conformance
  invariant 4). Mitigation against leakage is short expiry; the seams doc steers
  callers to minutes for sensitive objects.
- **Cross-tenant access.** The part signs whatever key it is given; choosing a
  safe, namespaced, server-derived key is the app's seam (seams.md §3). Letting
  the client pick the raw key is the main misuse and is called out explicitly.
- **SSRF / endpoint trust.** The endpoint is fixed configuration, not
  caller-controlled, and the part makes no requests itself, so it cannot be
  pointed at an internal host by an attacker. A compromised `STORAGE_ENDPOINT`
  env already implies a stronger attacker than this part defends against.
- **Injection via key.** Keys are URI-encoded per the S3 rules before they
  enter the canonical request and the URL; control characters are rejected
  outright, so a crafted key cannot break out of the path or the signature.
- **Clock skew.** `X-Amz-Date` is server time; an over-skewed server yields URLs
  the provider rejects as expired/not-yet-valid — an availability issue, not a
  security one, and outside the signer's control.

## Roadmap

- POST-policy uploads: browser form uploads with server-enforced content-type
  and size limits (the correct mechanism for constraining what a client can
  upload) — and the matching `presignUpload` content-type signing.
- Multipart upload presigning for large objects (part-number URLs + complete).
- A real S3-compatible round-trip in CI (the gated test already exists; wire a
  MinIO service into the verification harness).
- When a second provider/algorithm appears, the suite and capability move to
  the namespace (docs/02 §3-4).
