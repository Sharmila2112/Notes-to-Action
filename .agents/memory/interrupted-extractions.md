---
name: Interrupted extraction policy
description: Product constraints for recovery after a worker disappears.
---

Interrupted extractions should become readable terminal failures, not automatically restart or resume paid model work. Keep the original notes and let their owner deliberately retry.

**Why:** The user explicitly requested interruption detection without automatically spending more model credits, including deployments with multiple server instances.

**How to apply:** Preserve this policy if replacing in-process execution with a queue or adding recovery automation. A new server starting is not evidence that another instance's active extraction has stopped.

Recovery monitoring must use aggregate counts and fixed event categories, not
note content, user/run identifiers, or raw database exceptions.

**Why:** The user requires operational visibility without exposing user data.
ORM exceptions can embed SQL parameters containing original notes, so omitting
only explicit note fields is not sufficient.

**How to apply:** Keep new recovery diagnostics on an allowlist of operational
fields. Do not attach raw errors or user-derived labels to monitoring records.
