import { test, expect, run, task, trace } from './api-fixture';

test('stored events render retry/fallback callouts and replay in sequence at each speed', async ({ page, api }) => {
  api.seed(run('saved-trace', 'succeeded'), trace('saved-trace'));
  await page.clock.install({ time: new Date('2026-10-20T10:00:00.000Z') });
  await page.goto('/runs/saved-trace');
  await expect(page.getByTestId('text-retry-callout')).toHaveText('Retry recorded · attempt 2. Transient provider error; retry scheduled');
  await expect(page.getByTestId('text-fallback-callout')).toHaveText('Line-based fallback recorded. Using line-based fallback');
  await expect(page.getByText('4 persisted events · original durations')).toBeVisible();
  // Let Query's async notifications finish before freezing time. Once loaded,
  // clicks/assertions must not consume any part of a replay timing interval.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const replay = page.getByTestId('button-replay');
  for (const speed of [0.5, 1, 2]) {
    const speedButton = page.getByTestId(`button-speed-${speed}`);
    await speedButton.click();
    await expect(speedButton).toHaveAttribute('aria-pressed', 'true');
    await replay.click();
    await expect(replay).toContainText('Playing');
    await expect(page.getByTestId('step-receive_input')).toHaveClass(/completed/);
    await expect(page.getByTestId('step-call_model')).not.toHaveClass(/active/);
    const interval = 2000 / speed;
    await page.clock.runFor(interval - 1);
    await expect(page.getByTestId('step-call_model')).not.toHaveClass(/active/);
    await page.clock.runFor(1);
    await expect(page.getByTestId('step-call_model')).toHaveClass(/active/);
    await expect(page.getByTestId('step-parse_output')).not.toHaveClass(/active/);
    await page.clock.runFor(interval);
    await expect(page.getByTestId('step-parse_output')).toHaveClass(/active/);
    await expect(page.getByTestId('step-finish_run')).not.toHaveClass(/completed/);
    await page.clock.runFor(interval);
    await expect(page.getByTestId('step-finish_run')).toHaveClass(/completed/);
    await page.clock.runFor(interval);
    await expect(replay).toContainText('Play trace');
  }
  expect(api.posts).toEqual([]);
});

test('replay is disabled when there are no stored events', async ({ page, api }) => {
  api.seed(run('empty-trace', 'succeeded'));
  await page.goto('/runs/empty-trace');
  await expect(page.getByTestId('button-replay')).toBeDisabled();
  await expect(page.getByText('No events to replay yet')).toBeVisible();
});

test('task completion survives navigation, refetch, and reload (including undo)', async ({ page, api }) => {
  api.seed({ ...run('saved-tasks', 'succeeded'), tasks: [task('saved-tasks')] });
  await page.goto('/runs/saved-tasks');
  const checkbox = page.getByTestId('checkbox-task-task-1');
  await expect(checkbox).not.toBeChecked();
  // React controls this checkbox from an asynchronous mutation response.
  // check()/uncheck() require an immediate DOM toggle and race that response.
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  expect(api.patches).toEqual([{ id: 'task-1', data: { done: true } }]);
  await expect(page.getByTestId('row-task-task-1').locator('.task-title')).toHaveClass(/done/);
  const reads = api.detailReads.get('saved-tasks')!;
  await page.getByTestId('link-back-history').click();
  await page.getByTestId('link-run-saved-tasks').click();
  await expect.poll(() => api.detailReads.get('saved-tasks')!).toBeGreaterThan(reads);
  await expect(checkbox).toBeChecked();
  await page.reload();
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
  await page.reload();
  await expect(checkbox).not.toBeChecked();
  expect(api.patches).toEqual([
    { id: 'task-1', data: { done: true } },
    { id: 'task-1', data: { done: false } },
  ]);
  expect(api.posts).toEqual([]);
});

test('signed-out visitors stay behind the existing sign-in gate without API reads', async ({ page, api }) => {
  await page.addInitScript(() => localStorage.setItem('fixture-signed-out', 'true'));
  await page.goto('/runs/private-run');
  await expect(page.getByTestId('link-sign-in')).toBeVisible();
  await expect(page.getByTestId('button-extract')).toHaveCount(0);
  await page.getByTestId('link-sign-in').click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText('Sign-in SDK fixture')).toBeVisible();
  expect(api.detailReads.size).toBe(0);
  expect(api.posts).toEqual([]);
});
