---
name: Offline AI tests
description: Why automated retry and fallback verification must remain isolated from live AI usage.
---

Keep automated extraction-recovery tests offline, with deterministic provider
and persistence doubles rather than live Replit AI requests.

**Why:** The user requested verification of retries and fallbacks without
spending model credits.

**How to apply:** Extend offline service tests for new recovery cases. Do not
replace their mocked dependencies with live provider or database clients as a
shortcut to integration coverage.

Browser regressions should exercise real app code and generated hooks with
fail-closed HTTP fixtures. Keep any authentication SDK double in a separate,
loopback-only test configuration, never behind a flag in production code.

**Why:** Deterministic browser tests must not require paid extractions or weaken
the existing sign-in boundary. Fixture-session coverage is not proof that hosted
login or backend authorization works.

**How to apply:** Preserve this separation when extending the browser suite.
On Replit, prefer the provided Chromium wrapper over downloaded Linux binaries:
the latter can fail at launch with missing shared libraries even after a
successful browser installation. On other machines use Playwright's normal
browser installation or an explicit executable override.
