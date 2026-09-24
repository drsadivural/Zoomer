# Security Policy

Ayonix Zoomer processes **biometric data** — face templates used to verify the
identity of training attendees. Under Japan's APPI these are 個人識別符号
(personal identification codes), so we treat security reports seriously and
would rather hear about a problem early than tidily.

## Reporting a vulnerability

Email **security@ayonix.com** with:

- what you found and where (URL, endpoint, or file),
- the steps to reproduce it,
- what an attacker could do with it.

Please do **not** open a public GitHub issue for a security problem.

We aim to acknowledge within **3 business days** and to give an initial
assessment within **10 business days**. If a fix is going to take longer than
that, we will tell you why rather than go quiet.

Please do not access, modify or retain other people's data while testing, and do
not run denial-of-service or spam tests against production
(`https://zoomer.ayonix.com`). Testing against a local deployment is always
preferred; ask us if you need a staging account.

## Supported versions

Only the currently deployed production release is supported. There are no
long-lived release branches.

## What we do

| Control | Status | Where |
|---|---|---|
| Automated tests gate every change | Yes | `.github/workflows/ci.yml` |
| Typecheck + lint gate every change | Yes | `.github/workflows/ci.yml` |
| SAST (CodeQL, `security-extended`) | Yes — per PR and weekly | `.github/workflows/security.yml` |
| Dependency audit (SCA) | Yes — fails on high/critical in runtime deps | `.github/workflows/security.yml` |
| Automated dependency updates | Yes | `.github/dependabot.yml` |
| Secret scanning, including git history | Yes | `.github/workflows/security.yml` |
| Additive-migration guard | Yes — destructive DDL fails CI | `.github/workflows/ci.yml` |
| Peer review before merge | Yes — changes land via pull request | — |
| DAST | **Not yet** — planned against staging | — |
| Third-party penetration test | **Not yet performed** | — |

We would rather state the last two honestly than claim coverage we do not have.

## How the product protects data

Detail in [`docs/SECURITY_PRIVACY.md`](docs/SECURITY_PRIVACY.md); in summary:

- **Face templates are encrypted at rest** (AES-256-GCM) and **original images
  are not stored**. Templates are never sent to the browser — 1:1 and 1:N
  comparison happen server-side, so a tampered client cannot assert a match.
- **Evidence images** are encrypted, integrity-hashed (SHA-256), reachable only
  through **60-second HMAC-signed URLs**, and deleted automatically at the end
  of their retention window.
- **Tenant isolation**: every business table carries `organization_id` and every
  query filters on it; a token presented against another tenant is rejected.
- **Audit log** is append-only and deliberately excludes templates, image keys
  and tokens.
- **Meeting analysis stores no video.** Frames are discarded after inference;
  snapshots are off by default.
- Automated detections are **signals for a human to review**, never an automatic
  pass/fail for a trainee.

## Known limitations

Stated plainly, because a vendor questionnaire deserves the truth:

- **No third-party penetration test has been performed.**
- **No rate limiting** on API endpoints. Replay is prevented by
  `Idempotency-Key`, but volume is not bounded at the application layer;
  Cloudflare WAF rate limiting is the intended control.
- **Password authentication is bootstrap-only.** Cloudflare Workers' WebCrypto
  caps PBKDF2 at 100,000 iterations, which is below current guidance — SSO with
  MFA is the intended production path.
- **Liveness detection** (blink + motion) is a first-line defence and has not
  been evaluated against printed photos, screen replay or masks. See
  `docs/TEST_PLAN.md` §2.
- **Detection thresholds ship as sample values** and must be tuned on customer
  data (FAR/FRR) before relied upon.
