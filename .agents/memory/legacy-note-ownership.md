---
name: Legacy note ownership
description: Privacy constraint for historical shared meeting notes when introducing account ownership.
---

Formerly shared meeting notes must remain inaccessible to visitors unless their original owner can be independently verified. Never give all historical notes to the first signed-in account or provide a public claim-by-ID flow.

**Why:** Historical shared data has no reliable association with an authenticated person. Guessing ownership would expose another visitor's original notes.

**How to apply:** Preserve this restriction during migrations, demo seeding, account recovery, and future import or administrative tools. A meeting task's named assignee is not evidence of account ownership.
