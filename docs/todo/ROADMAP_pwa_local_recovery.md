# PWA local login recovery

Status: implementation and local-VM verification complete, 2026-11-08.
Production deployment is pending review. Changes are currently in the local
working tree based on `7224927`, not in the production branch.

## Scope and decisions

- Preserve cached entities when a login snapshot is slow or fails. Keep each
  actual merge in flight until it settles; check all merge results.
- Bound the UI wait for local login/logout persistence and device-key operations
  at 30 seconds. On failure, offer an explicit Reload without deleting website
  data. Do not start competing login writers in that failed page.
- Delay update reloads until login, transfer, logout and tracked local work finish.
- Resolve device-key writes on transaction commit and close database connections
  on every exit and version change.
- Keep optional push setup out of the critical login path.
- Give the mobile account list one bounded scroller; keep header drag-to-close.

## Validation completed

- [x] TypeScript check, lint (existing warnings, no errors), production frontend
  build and HTML-rewrite compatibility check.
- [x] Full frontend/data-layer suite: 720 tests in 61 files passed. Regression
  coverage includes delayed/failed merges, update coordination, timeout recovery,
  concurrent local work, key-transaction rollback and stalled database opening.
- [x] Built frontend served by cg.test, with existing imported test data and
  an existing browser profile. All 101 community memberships remain present.
- [x] Chromium mobile emulation: 412×824 and 360×640; real CDP touch gestures
  scroll a long Accounts list to Passkeys; the header still dismisses the sheet.
- [x] Delay delivery of a native community-database open success for ten seconds: no empty cache,
  no recovery error, successful completion.
- [x] Activate a real replacement service worker while that database open is
  held: no premature navigation; release the operation, then exactly one reload.
- [x] Withhold that open-success callback indefinitely: recovery appears after the local-data
  deadline; Reload restores sign-in and communities without deleting site data.
- [x] Email-code form: genuine server-side code verification, device registration,
  cache initialization and automatic device-key login after reload. The code was
  issued directly on the test VM; the mail-send response and email UI capability
  were supplied by the browser harness. No external email was sent in this test.
- [x] Desktop reload and a second tab retain sign-in without a recovery error.
- [x] Test-VM services healthy after deployment.

## Test deployment and evidence

Frontend build ID: `cg-pwa-recovery-20261108b`. cg.test serves the built assets.
The VM's existing backend code was retained; its image was rebuilt with the new
HTML shell and matching build ID, and api/wsapi plus gateway api/wsapi restarted.
The VM source checkout remains its earlier test revision: this was an artifact
deployment, not a source-branch update. Its modified `backup.sh` was preserved.

Local harnesses and logs (temporary, not required at runtime):
`/tmp/cg-pwa-test.cjs`, `/tmp/cg-pwa-code-login.cjs`,
`/tmp/cg-pwa-layout-smoke.cjs`, `/tmp/cg-pwa-browser.log`,
`/tmp/cg-pwa-code-login.log`, `/tmp/cg-pwa-layout-smoke.log`,
`/tmp/cg-pwa-all-tests.log`, `/tmp/cg-pwa-build.log`.
Original VM frontend and API shell are saved in
`/tmp/cg-pwa-original-frontend.tar.gz` and
`/tmp/cg-pwa-original-api-index.html` on the VM.

## Remaining

- [ ] Maintainer acceptance, including an actual Android/Brave device when available.
  The original phone state was deleted before diagnosis; these controlled
  reproductions do not identify its exact triggering event.
- [ ] Review, commit/merge and deploy to production after acceptance.
- [ ] Fold any remaining lasting notes into the topic docs and remove this roadmap.

Media delivery was not tested: the local VM has no copy of the S3 media.
Production was not changed.
