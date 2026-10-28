---
name: Deterministic demo failure
description: Why checked demo runs must always show an initial failure and recovery.
---

Checking “Simulate a transient failure” must always fail the first model-call
attempt and demonstrate the attempt 2 retry. It is not probabilistic.

**Why:** The user requires every demo run to visibly show the red failure and
recovery, rather than sometimes succeeding immediately.

**How to apply:** Preserve one initial injected failure per run, clearly marked
as demo mode. Do not inject another demo failure during stricter-output recovery.
Disabled demo mode must not inject failures.
