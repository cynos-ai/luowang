import { createRequire } from 'node:module';

import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const playwrightVersion = require('playwright/package.json').version;
const executablePath = chromium.executablePath();
const browser = await chromium.launch({ headless: true });

try {
  console.log(
    `Playwright browser smoke passed: Playwright ${playwrightVersion}, Chromium ${browser.version()}, executable ${executablePath}`,
  );
} finally {
  await browser.close();
}
