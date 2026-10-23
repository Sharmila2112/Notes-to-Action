import { test, expect, notes, run } from './api-fixture';

for (const terminal of ['succeeded', 'failed'] as const) {
  test(`Extract stays disabled through creation, pending and running, then enables on ${terminal}`, async ({ page, api }) => {
    api.holdCreate();
    await page.goto('/');
    const extract = page.getByTestId('button-extract');
    await expect(extract).toBeDisabled();
    await page.getByTestId('input-meeting-notes').fill(notes);
    await extract.click();
    await expect.poll(() => api.posts.length).toBe(1);
    await expect(extract).toBeDisabled();
    await expect(extract).toContainText('Starting');
    api.release();
    await expect(page.getByTestId('status-run-pending')).toBeVisible();
    await expect(extract).toBeDisabled();
    await expect.poll(() => api.eventReads.get('run-1') ?? 0).toBeGreaterThan(0);
    const detailReads = api.detailReads.get('run-1')!;
    const eventReads = api.eventReads.get('run-1')!;
    api.setStatus('run-1', 'running');
    await expect(page.getByTestId('status-run-running')).toBeVisible();
    await expect(extract).toBeDisabled();
    // These requests must come from the generated hooks' real polling.
    await expect.poll(() => api.detailReads.get('run-1')!).toBeGreaterThan(detailReads);
    await expect.poll(() => api.eventReads.get('run-1')!).toBeGreaterThan(eventReads);
    api.setStatus('run-1', terminal);
    await expect(page.getByTestId(`status-run-${terminal}`)).toBeVisible();
    await expect(extract).toBeEnabled();
    await expect(page.getByTestId('input-meeting-notes')).toHaveValue(notes);
    expect(api.posts).toEqual([{ input_text: notes, simulate_failures: false }]);
    // Stop means stop: advancing the browser clock cannot schedule more polls.
    await page.clock.install();
    await page.clock.runFor(1200); // let an already-scheduled events poll settle
    const stoppedAt = [api.detailReads.get('run-1'), api.eventReads.get('run-1')];
    await page.clock.runFor(4000);
    expect([api.detailReads.get('run-1'), api.eventReads.get('run-1')]).toEqual(stoppedAt);
  });
}

test('failed extraction preserves original notes and Retry creates a fresh run with the current demo option', async ({ page, api }) => {
  await page.goto('/');
  await page.getByTestId('input-meeting-notes').fill(notes);
  await page.getByTestId('checkbox-simulate-failures').check();
  await page.getByTestId('button-extract').click();
  await expect(page.getByTestId('status-run-pending')).toBeVisible();
  api.setStatus('run-1', 'failed');
  await expect(page.getByTestId('status-failed-run')).toContainText('Your notes are saved');
  await expect(page.getByTestId('input-meeting-notes')).toHaveValue(notes);
  await expect(page.locator('.source-text')).toHaveText(notes);
  // Retry uses the failed run's source, not unrelated edits in the composer.
  await page.getByTestId('input-meeting-notes').fill('Unrelated unsent draft');
  await page.getByTestId('checkbox-simulate-failures').uncheck();
  await page.getByTestId('button-retry-run').click();
  await expect.poll(() => api.posts.length).toBe(2);
  expect(api.posts).toEqual([
    { input_text: notes, simulate_failures: true },
    { input_text: notes, simulate_failures: false },
  ]);
  await expect.poll(() => api.detailReads.get('run-2') ?? 0).toBeGreaterThan(0);
  await expect(page.getByTestId('status-run-pending')).toBeVisible();
  await expect(page.getByTestId('input-meeting-notes')).toHaveValue(notes);
  expect(api.runs.get('run-1')?.status).toBe('failed');
});

test('retry from stored history sends original notes, disables demo mode, and navigates to a new run', async ({ page, api }) => {
  api.seed(run('saved-failure', 'failed'));
  await page.goto('/runs/saved-failure');
  await expect(page.getByTestId('status-failed-run')).toBeVisible();
  await page.getByTestId('button-retry-run').click();
  await expect(page).toHaveURL(/\/runs\/run-1$/);
  await expect(page.getByTestId('status-run-pending')).toBeVisible();
  expect(api.posts).toEqual([{ input_text: notes, simulate_failures: false }]);
  expect(api.runs.get('saved-failure')?.status).toBe('failed');
});

test('a rejected create request leaves notes intact and Extract usable', async ({ page, api }) => {
  api.rejectCreate = true;
  await page.goto('/');
  await page.getByTestId('input-meeting-notes').fill(notes);
  await page.getByTestId('button-extract').click();
  await expect(page.getByRole('alert')).toContainText('Could not start extraction');
  await expect(page.getByTestId('input-meeting-notes')).toHaveValue(notes);
  await expect(page.getByTestId('button-extract')).toBeEnabled();
  expect(api.posts).toHaveLength(1);
});
