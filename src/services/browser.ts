import { chromium, Browser, Page } from 'playwright';

let browserInstance: Browser | null = null;

export async function getCDPBrowser(cdpUrl: string = 'http://localhost:9222'): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.connectOverCDP(cdpUrl);
  }
  return browserInstance;
}

export async function executeBrowserAction(
  action: 'navigate' | 'click' | 'scrape',
  targetUrl?: string,
  selector?: string
) {
  const browser = await getCDPBrowser();
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();
  const page: Page = pages.length > 0 ? pages[0] : await context.newPage();

  switch (action) {
    case 'navigate':
      if (!targetUrl) throw new Error('URL required for navigation');
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      return { status: 'success', url: page.url(), title: await page.title() };

    case 'click':
      if (!selector) throw new Error('CSS selector required for click action');
      await page.click(selector);
      return { status: 'success', clicked: selector };

    case 'scrape':
      const content = await page.evaluate(() => document.body.innerText);
      return {
        status: 'success',
        url: page.url(),
        content: content.slice(0, 4000), // Trim payload size
      };

    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}