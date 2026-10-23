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
