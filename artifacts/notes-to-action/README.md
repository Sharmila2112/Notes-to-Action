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
