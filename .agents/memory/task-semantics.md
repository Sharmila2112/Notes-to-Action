---
name: Task ownership and calendar semantics
description: Product-specific meaning of owner and date-derived priority.
---

For this product, a named recipient or meeting participant is the task owner,
even when conventional task assignment would treat a different person as the actor.

**Why:** The user explicitly requested that the person named in each action own it,
including actions to provide information to someone and meetings with someone.

**How to apply:** Preserve this meaning in extraction prompts, parsing, and fallback
logic; do not replace it with conventional responsibility/assignee inference.

Priority is calendar-date based: HIGH within three days including today and the
third day; MEDIUM for later dated work; LOW without a due date.

**Why:** The user rejected uniform model-supplied MEDIUM priorities. Calendar-day
resolution should reflect the user's date rather than the server's UTC boundary.

**How to apply:** Anchor relative dates and priority derivation to the same reference
day through retries and fallback. Do not silently modify old saved runs to update
their original extraction priorities.

Merge a generic sync/discussion and the concrete deliverable it describes into
one task, retaining the more specific actionable title and earliest due date.
Do not merge different deliverables solely because they share a person.

**Why:** The user considers the general sync and its requested information to be
the same work and explicitly requested a single task rather than both entries.

**How to apply:** Apply duplicate merging before saving, including recovery and
fallback paths, and recalculate priority from the retained date.
