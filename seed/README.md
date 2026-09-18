# seed

`seed.sql` is **generated, not committed** — it embeds the bootstrap password
hash for whichever environment it was made for.

```bash
node scripts/make-seed.mjs            # random password
node scripts/make-seed.mjs "<chosen>" # explicit password
```

The generator writes:

- `seed/seed.sql` — organization, `admin@ayonix.com` (sys_admin),
  `auditor@ayonix.com` (read-only), default detection rules, and six sample
  trainees matching the mockup roster.
- `.secrets/bootstrap.txt` — the generated credentials.

Ids are stable, so re-running rotates the bootstrap password instead of creating
a second organization.

```bash
npm run seed:local     # apply to the local D1
npm run seed:remote    # apply to the deployed D1
```

`reset.sql` clears every tenant table. It is destructive and intended only for
development or resetting a demo environment.
