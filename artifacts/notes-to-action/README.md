# Notes to Action

Notes to Action turns meeting notes and rough to-do lists into tasks. Runs and their event histories are stored in PostgreSQL so diagrams can be reviewed and replayed later.


## Sign-in and privacy

- Replit-managed Clerk handles sign-in and sign-up. Its keys are provisioned through Replit; do not commit them.
- All run and task endpoints require a signed-in session. Runs are assigned to that session's user, and tasks and events inherit access through their run.
- Requests for another user's records return the same 404 as missing records. Private responses are not cached, and the UI discards its query cache when the session changes.
- Older shared runs have no verified owner. They remain in the database but are inaccessible to visitors; they are never assigned to the first person who signs in.
- Meeting task assignees (the task's “Owner” field) are not account owners and do not grant access.
- Notes are sent to the AI service for extraction; account privacy does not mean processing stays entirely in the app.
- Run `pnpm --filter @workspace/db run push` after schema changes. The post-merge script applies the schema automatically.
- `pnpm --filter @workspace/api-server test` includes two-user access checks against the development database. It uses isolated fixtures, cleans them up, and makes no model calls.


### Managed production auth configuration

The managed Clerk deployment system automatically supplies `VITE_CLERK_PROXY_URL` during production builds. This is separate from initial key provisioning, which creates only the Clerk key variables. An absent proxy setting in development is expected: the development Clerk instance is accessed directly.

The web client passes that managed value unconditionally to `ClerkProvider.proxyUrl`, and the API mounts the canonical proxy middleware at `/api/__clerk` before body parsing. Do not hardcode a production proxy fallback or manually set the managed variable. Replit's auth setup instructions require this same wiring for development and production.

Reference: [Replit Clerk Auth documentation](https://docs.replit.com/features/auth-and-identity/clerk-auth), and the workspace Clerk setup instructions in `.local/skills/clerk-auth/references/setup-and-customization.md`.

The browser sign-in, private-run detail, and sign-out flow were verified in the development preview. Production-host sign-in was not exercised: this task must not deploy or modify the live app.

## Run steps

Each extraction records start and finish events for these steps:

1. `receive_input` — validate that notes are present and no longer than 10,000 characters.
2. `create_run` — move the run from `pending` to `running`.
3. `call_model` — request JSON from OpenAI `gpt-5.6-terra` through Replit AI Integrations, with a 20-second timeout.
4. `parse_output` — validate titles and priorities; retry once with a stricter JSON prompt if parsing fails.
5. `save_tasks` — persist the validated tasks.
6. `finish_run` — mark the run `succeeded` or `failed`.

## Failure paths

- Model timeouts and errors are retried once after a short wait. Failed and retrying attempts are stored as events.
- Invalid JSON gets one stricter-prompt retry. If the response is still invalid, the app extracts lines beginning with `-`, `*`, `TODO`, or `[ ]` and records the fallback.
- The “Simulate failures” option injects a real first-attempt model-call error about half the time. Related event details start with `(demo mode)`.
- Empty or overlong notes create a run before validation; invalid runs are marked failed and keep the original input and event history.

## Automated extraction tests

Run `pnpm --filter @workspace/api-server test` from the workspace root.

The service tests inject a scripted provider, in-memory persistence, a virtual
clock, abort signals, and fixed random values. They do not load the live AI
client or connect to PostgreSQL, and a network guard fails the suite if a test
attempts to use `fetch`.

Coverage includes provider errors and timeouts, empty responses, retry limits,
demo-mode markers, stricter JSON prompts, fallback extraction (including zero
matching lines), ordered diagram events and attempt numbers, save/finalization
errors, and readable failed-run snapshots retaining the original input. A
stricter request that exhausts its transport retries is terminal; the line
fallback is used when both received responses fail JSON/task validation.
