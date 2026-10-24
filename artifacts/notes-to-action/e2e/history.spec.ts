import { test, expect, run, type ApiFixture } from './api-fixture';

function seedHistory(api: ApiFixture, count: number) {
  for (let index = 1; index <= count; index += 1) {
    const id = `history-${String(index).padStart(3, '0')}`;
    api.seed({
      ...run(id, 'succeeded'),
      input_text: `${id} ` + 'Preview notes. '.repeat(30) + 'Full detail note tail',
      started_at: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString(),
    });
  }
}

test('history appends bounded pages in order, disables duplicate loads, and still opens full notes', async ({ page, api }) => {
  seedHistory(api, 45);
  await page.goto('/runs');
  const rows = page.locator('.run-row');
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText('history-045');
  await expect(rows.last()).toContainText('history-026');
  await expect(page.getByText('Full detail note tail')).toHaveCount(0);
  expect(api.historyReads).toEqual([{ cursor: null, limit: 20 }]);
  api.holdHistoryPage();
  const more = page.getByTestId('button-load-more');
  await more.click();
  await expect(more).toBeDisabled();
  await expect(more).toContainText('Loading more');
  await expect.poll(() => api.historyReads.length).toBe(2);
  api.releaseHistory();
  await expect(rows).toHaveCount(40);
  await expect(rows.last()).toContainText('history-006');
  await more.click();
  await expect(rows).toHaveCount(45);
  await expect(page.getByTestId('history-page-status')).toHaveText('45 runs loaded · All runs loaded');
  await expect(more).toHaveCount(0);
  const ids = await rows.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(new Set(ids).size).toBe(45);
  expect(api.historyReads.map((read) => read.cursor)).toEqual([null, 'history-026', 'history-006']);
  await rows.first().click();
  await expect(page.locator('.source-text')).toContainText('Full detail note tail');
});

test('empty history shows its starting action and has no load-more control', async ({ page, api }) => {
  await page.goto('/runs');
  await expect(page.getByText('No runs yet')).toBeVisible();
  await expect(page.getByTestId('link-first-run')).toBeVisible();
  await expect(page.getByTestId('button-load-more')).toHaveCount(0);
  expect(api.historyReads).toEqual([{ cursor: null, limit: 20 }]);
});

test('an initial page error has a working retry action', async ({ page, api }) => {
  seedHistory(api, 1);
  api.rejectHistory.add('first');
  await page.goto('/runs');
  await expect(page.getByRole('alert')).toContainText('History could not load');
  await expect(page.getByText('No runs yet')).toHaveCount(0);
  api.rejectHistory.delete('first');
  await page.getByTestId('button-retry-history').click();
  await expect(page.locator('.run-row')).toHaveCount(1);
  await expect(page.getByTestId('button-load-more')).toHaveCount(0);
});

test('load-more failure retains existing rows and retry uses the same cursor without duplicates', async ({ page, api }) => {
  seedHistory(api, 25);
  await page.goto('/runs');
  await expect(page.locator('.run-row')).toHaveCount(20);
  api.rejectHistory.add('history-006');
  await page.getByTestId('button-load-more').click();
  await expect(page.getByRole('alert')).toContainText('Your loaded runs are still here');
  await expect(page.locator('.run-row')).toHaveCount(20);
  await expect(page.getByTestId('button-load-more')).toHaveText('Try again');
  api.rejectHistory.delete('history-006');
  await page.getByTestId('button-load-more').click();
  await expect(page.locator('.run-row')).toHaveCount(25);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.historyReads.map((read) => read.cursor)).toEqual([null, 'history-006', 'history-006']);
});

test('mobile history pages append without making the document horizontally scrollable', async ({ page, api }) => {
  seedHistory(api, 21);
  await page.setViewportSize({ width: 375, height: 874 });
  await page.goto('/runs');
  await expect(page.locator('.run-row')).toHaveCount(20);
  await page.getByTestId('button-load-more').click();
  await expect(page.locator('.run-row')).toHaveCount(21);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('filters search the complete history, keep pages bounded, reset cursors, and clear safely', async ({ page, api }) => {
  for (let index = 1; index <= 45; index += 1) {
    const id = `filtered-${String(index).padStart(3, '0')}`;
    api.seed({
      ...run(id, index <= 25 ? 'succeeded' : 'failed'),
      input_text: `Quarterly planning notes ${index}`,
      started_at: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString(),
    });
  }
  await page.goto('/runs');
  await expect(page.locator('.run-row')).toHaveCount(20);
  await page.getByTestId('input-history-search').fill('planning');
  await page.getByTestId('input-history-from').fill('2026-10-20');
  await page.getByTestId('input-history-to').fill('2026-10-20');
  await page.getByTestId('select-history-status').selectOption('succeeded');
  await page.getByTestId('button-apply-history-filters').click();
  await expect(page.locator('.run-row')).toHaveCount(20);
  await expect(page.locator('.run-row').first()).toHaveAttribute('href', '/runs/filtered-025');
  await expect(page.locator('.run-row').last()).toHaveAttribute('href', '/runs/filtered-006');
  expect(api.historyReads.at(-1)).toEqual({
    cursor: null, limit: 20,
    filters: { search: 'planning', from: '2026-10-20', to: '2026-10-20', status: 'succeeded' },
  });
  await page.getByTestId('button-load-more').click();
  await expect(page.locator('.run-row')).toHaveCount(25);
  expect(api.historyReads.at(-1)?.cursor).toBe('filtered-006');
  await page.getByTestId('select-history-status').selectOption('failed');
  await page.getByTestId('button-apply-history-filters').click();
  await expect(page.locator('.run-row')).toHaveCount(20);
  await expect(page.locator('.run-row').first()).toHaveAttribute('href', '/runs/filtered-045');
  expect(api.historyReads.at(-1)).toEqual({
    cursor: null, limit: 20,
    filters: { search: 'planning', from: '2026-10-20', to: '2026-10-20', status: 'failed' },
  });
  await page.getByTestId('button-clear-history-filters').click();
  await expect(page.locator('.run-row')).toHaveCount(20);
  expect(api.historyReads.at(-1)).toEqual({ cursor: null, limit: 20 });
  await page.getByTestId('input-history-search').fill('no matching phrase');
  await page.getByTestId('button-apply-history-filters').click();
  await expect(page.getByText('No matching runs')).toBeVisible();
  await expect(page.getByText('No runs yet')).toHaveCount(0);
  await page.getByTestId('button-clear-empty-history').click();
  await expect(page.locator('.run-row')).toHaveCount(20);
  expect(api.unexpected).toEqual([]);
});
