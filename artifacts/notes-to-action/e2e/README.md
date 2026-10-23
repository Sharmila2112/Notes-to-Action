# Offline browser regressions

From the workspace root:

```sh
pnpm --filter @workspace/notes-to-action exec playwright install chromium
pnpm --filter @workspace/notes-to-action run test:browser
pnpm --filter @workspace/notes-to-action run typecheck:browser
```

The suite starts its own loopback-only Vite server on port 4179. No API server,
database, user account, credentials, or paid AI access is needed. All `/api/*`
requests are intercepted with typed, per-test fixtures; unmatched API calls fail
the test, and requests to external origins are aborted. Generated hooks and
their polling run unmodified. Replay timing uses Playwright's virtual clock,
not wall-clock sleeps.

On Replit the runner automatically uses the provided Chromium wrapper (which
includes the system libraries missing from downloaded Linux browsers). Elsewhere
it uses Playwright's installed Chromium. To use another system Chromium, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable path.

The **separate** `e2e/vite.config.ts` replaces the Clerk SDK with a deterministic
test double while retaining the application's real AuthProvider, AuthGate,
session-scoped QueryClient, routing, and UI. Neither production Vite config nor
production code imports any test files or checks for a bypass flag. This suite
checks app behavior for a fixture session and the signed-out gate; it does **not**
claim to test Clerk's hosted login, cookies, or backend authorization.

Failures save screenshots and traces under the ignored
`generated-artifacts/browser-results/` directory at the workspace root.
