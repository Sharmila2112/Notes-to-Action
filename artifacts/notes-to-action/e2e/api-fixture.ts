import { test as base, expect, type Page } from '@playwright/test';
import type { RunDetail, RunEvent, RunInput, RunStatus, Task } from '@workspace/api-client-react';

export const notes = 'Mira will send the launch brief by Thursday.\nFinance will review the revised numbers.';
const timestamp = '2026-10-20T10:00:00.000Z';

export function run(id = 'run-1', status: RunStatus = 'pending'): RunDetail {
  return {
    id, input_text: notes, status, started_at: timestamp,
    finished_at: status === 'failed' || status === 'succeeded' ? timestamp : null,
    error: status === 'failed' ? 'Provider unavailable. Your notes are saved.' : null,
    tasks: [],
  };
}

export function task(runId = 'run-1'): Task {
  return { id: 'task-1', run_id: runId, title: 'Send launch brief', owner: 'Mira', due_date: null, priority: 'high', done: false };
}

// Deliberately out of order: the UI must use sequence, not response array order.
export function trace(runId = 'run-1'): RunEvent[] {
  const items: [RunEvent['step'], RunEvent['status'], string, number][] = [
    ['receive_input', 'succeeded', 'Source accepted', 1],
    ['call_model', 'retrying', 'Transient provider error; retry scheduled', 2],
    ['parse_output', 'retrying', 'Using line-based fallback', 2],
    ['finish_run', 'succeeded', 'Tasks saved successfully', 2],
  ];
  const events = items.map(([step, status, detail, attempt], index) => ({
    id: `event-${index + 1}`, run_id: runId, sequence: index + 1,
    step, status, detail, attempt, timestamp, duration_ms: 2000,
  }));
  return [events[2], events[0], events[3], events[1]];
}

export class ApiFixture {
  runs = new Map<string, RunDetail>();
  events = new Map<string, RunEvent[]>();
  posts: RunInput[] = [];
  patches: { id: string; data: unknown }[] = [];
  detailReads = new Map<string, number>();
  eventReads = new Map<string, number>();
  unexpected: string[] = [];
  rejectCreate = false;
  private releaseCreate?: () => void;
  private createGate: Promise<void> = Promise.resolve();

  holdCreate() {
    this.createGate = new Promise<void>((resolve) => { this.releaseCreate = resolve; });
  }
  release() { this.releaseCreate?.(); }
  seed(detail: RunDetail, events: RunEvent[] = []) {
    this.runs.set(detail.id, detail);
    this.events.set(detail.id, events);
  }
  setStatus(id: string, status: RunStatus) {
    const current = this.runs.get(id)!;
    this.runs.set(id, { ...current, status,
      finished_at: status === 'failed' || status === 'succeeded' ? timestamp : null,
      error: status === 'failed' ? 'Provider unavailable. Your notes are saved.' : null,
    });
  }
  async install(page: Page) {
    // Fail closed: no real backend, Clerk, fonts, or model request can escape.
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:4179') {
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const method = request.method();
      const path = url.pathname;
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      if (path === '/api/runs' && method === 'GET') {
        return json([...this.runs.values()].map(({ tasks, ...detail }) => ({ ...detail, task_count: tasks.length })));
      }
      if (path === '/api/runs' && method === 'POST') {
        const input = request.postDataJSON() as RunInput;
        this.posts.push(input);
        await this.createGate;
        if (this.rejectCreate) return json({ error: 'Fixture create rejected' }, 503);
        const created = { ...run(`run-${this.posts.length}`), input_text: input.input_text };
        this.seed(created);
        return json(created, 201);
      }
      const detailMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (detailMatch && method === 'GET' && this.runs.has(detailMatch[1])) {
        const id = detailMatch[1];
        this.detailReads.set(id, (this.detailReads.get(id) ?? 0) + 1);
        return json(this.runs.get(id));
      }
      const eventMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (eventMatch && method === 'GET' && this.runs.has(eventMatch[1])) {
        const id = eventMatch[1];
        this.eventReads.set(id, (this.eventReads.get(id) ?? 0) + 1);
        return json(this.events.get(id) ?? []);
      }
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && method === 'PATCH') {
        const data = request.postDataJSON();
        this.patches.push({ id: taskMatch[1], data });
        for (const detail of this.runs.values()) {
          const found = detail.tasks.find((item) => item.id === taskMatch[1]);
          if (found) {
            const updated = { ...found, done: data.done };
            detail.tasks = detail.tasks.map((item) => item.id === updated.id ? updated : item);
            return json(updated);
          }
        }
      }
      this.unexpected.push(`${method} ${path}`);
      return json({ error: `Unexpected fixture request: ${method} ${path}` }, 500);
    });
  }
}

export const test = base.extend<{ api: ApiFixture }>({
  api: async ({ page }, use) => {
    const api = new ApiFixture();
    await api.install(page);
    await use(api);
    api.release();
    expect(api.unexpected, 'All API calls must match deterministic fixtures').toEqual([]);
  },
});
export { expect };
