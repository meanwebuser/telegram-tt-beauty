import { chromium } from '@playwright/test';

const targetHost = process.env.TGB_HOST || 'tgb.example.com';
const cdpUrl = process.env.BROWSEROS_CDP_URL || 'http://127.0.0.1:9222';

const browser = await chromium.connectOverCDP(cdpUrl);
let smokePassed = false;
try {
  const findPage = () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
    try {
      return new URL(candidate.url()).hostname === targetHost;
    } catch {
      return false;
    }
  });
  let page = findPage();

  if (!page) {
    const context = browser.contexts()[0];
    page = await context.newPage();
    await page.goto(`https://${targetHost}/?mcp_smoke=20260807`, { waitUntil: 'domcontentloaded' });
  }

  const errors = [];
  const observePage = (candidate) => {
    candidate.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    candidate.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
  };
  observePage(page);

  const refreshPage = () => {
    const current = findPage();
    if (current && current !== page) {
      page = current;
      observePage(page);
    }
    return page;
  };

  const visible = async (locator, label) => {
    await locator.waitFor({ state: 'visible', timeout: 15_000 });
    return locator;
  };
  const pickVisible = async (locator, label) => {
    await locator.first().waitFor({ state: 'attached', timeout: 15_000 });
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
    throw new Error(`${label} has no visible match`);
  };
  const domClick = async (locator, label) => {
    const element = await pickVisible(locator, label);
    await element.click({ force: true, noWaitAfter: true, timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    refreshPage();
  };

  await visible(page.locator('#root'), 'TGB root');
  const openMenus = () => page.getByRole('button', { name: /open menu/i });
  const settingsItems = () => page.getByRole('menuitem', { name: /^settings$/i });
  let settingsMenuOpen = false;
  try {
    await pickVisible(settingsItems(), 'Settings menu item');
    settingsMenuOpen = true;
  } catch {
    // The menu is closed; open it below.
  }
  let openMenu;
  if (!settingsMenuOpen) {
    for (let attempt = 0; attempt < 3 && !openMenu; attempt += 1) {
      try {
        openMenu = await pickVisible(openMenus(), 'Open menu');
        break;
      } catch {
        const backs = page.getByRole('button', { name: /go back/i });
        try {
          await pickVisible(backs, 'Go back');
        } catch {
          break;
        }
        await domClick(backs, 'Go back');
      }
    }
    if (!openMenu) {
      throw new Error('Open menu did not become visible in the authenticated TGB tab');
    }
    await domClick(openMenu, 'Open menu');
  }
  await domClick(settingsItems(), 'Settings menu item');

  const aiAssistant = page.getByRole('button', { name: /^AI Assistant$/i });
  await domClick(aiAssistant, 'AI Assistant');
  await pickVisible(page.getByLabel('API key'), 'AI API key field');
  await pickVisible(page.getByLabel('Base URL / Endpoint'), 'AI endpoint field');
  await pickVisible(page.getByLabel('Model'), 'AI model field');
  await pickVisible(page.getByText(/Cross-device sync/i), 'cross-device sync control');
  await pickVisible(page.getByRole('button', { name: /Browser MCP/i }), 'Browser MCP control');

  await domClick(page.getByRole('button', { name: /go back/i }), 'Go back from AI');
  await domClick(openMenus(), 'Open menu after AI back');
  await domClick(settingsItems(), 'Settings menu item after AI back');
  const generalSettings = page.getByRole('button', { name: /General Settings/i });
  await domClick(generalSettings, 'General Settings');
  await pickVisible(page.getByRole('heading', { name: /^General$/i }), 'General settings heading');

  const crashErrors = errors.filter((message) => /InvalidCharacterError|createElementNS|reading 'tagName'|undefined is not a function/i.test(message));
  if (crashErrors.length) {
    throw new Error(`TGB browser smoke observed UI crash errors:\n${crashErrors.join('\n')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    host: targetHost,
    checked: ['settings', 'ai-assistant', 'ai-fields', 'browser-mcp-control', 'general-settings'],
    crashErrors: 0,
  }));
  smokePassed = true;
} catch (error) {
  console.error(error?.stack || error);
} finally {
  // Disconnect only. Do not close the user's BrowserOS tabs or shared profile.
  browser._connection.close();
  process.exit(smokePassed ? 0 : 1);
}
