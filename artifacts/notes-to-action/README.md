# Notes to Action

Notes to Action turns meeting notes and rough to-do lists into tasks. Runs and their event histories are stored in PostgreSQL so diagrams can be reviewed and replayed later.

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
