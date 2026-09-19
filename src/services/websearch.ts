import { chromium, Browser } from 'playwright';
import { extractCleanMarkdown } from '../utils/dom_cleaner.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export interface WebSearchOptions {
  searxngUrl?: string;
}

export class WebSearchService {
  private searxngUrl: string;
  private browser: Browser | null = null;

  constructor(options: WebSearchOptions = {}) {
    this.searxngUrl = options.searxngUrl || process.env.SEARXNG_URL || 'http://localhost:8080';
  }

  /**
   * Queries a local SearXNG instance for JSON search results.
   */
  async webSearch(query: string, limit: number = 5): Promise<SearchResult[]> {
    const url = new URL('/search', this.searxngUrl);
    url.searchParams.append('q', query);
    url.searchParams.append('format', 'json');

    try {
      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`SearXNG query failed with status ${response.status}`);
      }

      const data = await response.json();
      const results: any[] = data.results || [];

      return results.slice(0, limit).map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.content || r.snippet || '',
        engine: r.engine,
      }));
    } catch (err) {
      console.error('[WebSearchService] Search error:', err);
      throw err;
    }
  }

  /**
   * Navigates to a target URL via Playwright and extracts clean Markdown content.
   */
  async browserAction(targetUrl: string, action: 'scrape' | 'screenshot' = 'scrape'): Promise<{ content?: string; buffer?: Buffer }> {
    let browserInstance = this.browser;
    let createdLocalBrowser = false;

    if (!browserInstance) {
      const cdpEndpoint = process.env.CDP_ENDPOINT;
      if (cdpEndpoint) {
        browserInstance = await chromium.connectOverCDP(cdpEndpoint);
      } else {
        browserInstance = await chromium.launch({ headless: true });
        createdLocalBrowser = true;
      }
    }

    const context = await browserInstance.newContext();
    const page = await context.newPage();

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      if (action === 'screenshot') {
        const buffer = await page.screenshot({ fullPage: true });
        return { buffer };
      }

      const htmlContent = await page.content();
      const { title, markdown } = extractCleanMarkdown(htmlContent, targetUrl);

      return {
        content: `# ${title}\n\nSource: ${targetUrl}\n\n${markdown}`,
      };
    } finally {
      await page.close();
      await context.close();
      if (createdLocalBrowser && browserInstance) {
        await browserInstance.close();
      }
    }
  }
}