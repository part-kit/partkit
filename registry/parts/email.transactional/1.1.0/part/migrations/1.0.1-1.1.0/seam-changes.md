# email.transactional 1.0.1 → 1.1.0 — seam changes

**None.** Purely additive: this minor adds the **`ses`** (Amazon SES) adapter.
`resend` and `postmark` are unchanged, and the `send()` interface, `EmailMessage`,
and every invariant are identical. Existing apps need no changes.

## Switching to SES (one commit)

```
partkit upgrade email.transactional --adapter=ses
```

No seam changes — the same `send()` calls work. Then set the SES env (seams.md
§SES): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and an
`EMAIL_FROM` that is a **verified** SES sender. The one-time AWS setup (verify a
sending identity + DKIM, request production access out of the sandbox, grant
`ses:SendEmail`) is a documented checklist in seams.md — the code is zero-work;
no `aws-sdk`, no signing to write.

Staying on resend/postmark requires no action.
