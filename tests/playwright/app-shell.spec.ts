import { expect, test } from '@playwright/test';

test('mocked TGB app shell boots without a page crash', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();

  expect(pageErrors.filter((message) => /InvalidCharacterError|tagName|createElementNS/i.test(message))).toEqual([]);
});
