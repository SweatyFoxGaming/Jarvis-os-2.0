import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import net from "node:net";

export interface BrowserPageCapture {
  [key: string]: any;

  title: string;
  url: string;
  description: string;
  text: string;
  screenshotPath?: string;
  category?: string;
  capturedAt?: string;
}

export interface BrowserSearchResult {
  title: string;
  url: string;
  description: string;
  text?: string;
  screenshotPath?: string;
  category?: string;
}

export interface BrowserSearchOptions {
  maxResults?: number;
  pagesToCapture?: number;
  timeoutMs?: number;
  category?: string;
}

export interface BrowserResearchResult {
  query: string;
  category: string;
  results: BrowserSearchResult[];
  sessionPath?: string;
}

export interface BrowserResearchBatch {
  sessionId: string;
  pages: BrowserPageCapture[];
  failures: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_PAGES_TO_CAPTURE = 3;

function getEvidenceDirectory(): string {
  return (
    process.env.JARVIS_RESEARCH_EVIDENCE_DIR?.trim() ||
    "/tmp/jarvis-research"
  );
}

function isSafePublicUrl(rawUrl: string): boolean {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return false;
  }

  const ipType = net.isIP(hostname);

  if (ipType === 4) {
    const parts = hostname.split(".").map(Number);

    const [a, b, c] = parts;

    if (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    ) {
      return false;
    }

    if (
      a === 100 &&
      b >= 64 &&
      b <= 127
    ) {
      return false;
    }

    if (
      a === 192 &&
      b === 0 &&
      c === 0
    ) {
      return false;
    }
  }

  if (ipType === 6) {
    const normalized = hostname.replace(
      /^\[|\]$/g,
      "",
    );

    if (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    ) {
      return false;
    }
  }

  return true;
}

function safeFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) ||
    "page"
  );
}

/**
 * Normalize research categories into stable vault-friendly names.
 */
export function normalizeCategory(
  value: unknown,
): string {
  const raw =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "general";

  if (!raw) {
    return "General";
  }

  const aliases: Record<string, string> = {
    research: "Research",
    general: "General",
    technical: "Technical",
    technology: "Technical",
    tech: "Technical",
    coding: "Technical",
    programming: "Technical",
    academic: "Academic",
    science: "Academic",
    scientific: "Academic",
    news: "News",
    current: "News",
    business: "Business",
    finance: "Finance",
    finance_and_business: "Finance",
    reference: "Reference",
  };

  if (aliases[raw]) {
    return aliases[raw];
  }

  return (
    raw.charAt(0).toUpperCase() +
    raw.slice(1)
  );
}

export function buildResearchSessionPath(
  categoryOrQuery?: unknown,
  sessionId?: unknown,
): string {
  const category =
    normalizeCategory(categoryOrQuery);

  const safeCategory = safeFilename(
    category,
  );

  const suppliedId =
    typeof sessionId === "string" &&
    sessionId.trim()
      ? sessionId.trim()
      : new Date()
          .toISOString()
          .replace(/[:.]/g, "-");

  const safeSession =
    safeFilename(suppliedId);

  return path.join(
    getEvidenceDirectory(),
    safeCategory,
    safeSession,
  );
}

function resolveSearchResultUrl(
  href: string,
  searchUrl: string,
): string | null {
  try {
    const url = new URL(
      href,
      searchUrl,
    );

    const redirected =
      url.searchParams.get("uddg");

    const destination =
      redirected || url.toString();

    const decoded =
      redirected
        ? decodeURIComponent(destination)
        : destination;

    return isSafePublicUrl(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}

async function extractReadableText(
  page: Page,
): Promise<string> {
  const text = await page.evaluate(() => {
    const unwantedSelectors = [
      "script",
      "style",
      "noscript",
      "svg",
      "canvas",
      "iframe",
      "nav",
      "header",
      "footer",
      "form",
      "aside",
    ];

    for (const selector of unwantedSelectors) {
      document
        .querySelectorAll(selector)
        .forEach((node) => node.remove());
    }

    return document.body?.innerText || "";
  });

  return String(text)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(
      /\n\s*\n\s*\n+/g,
      "\n\n",
    )
    .trim();
}

async function createBrowser(): Promise<Browser> {
  const executablePath =
    process.env.BROWSER_EXECUTABLE_PATH?.trim() ||
    "/usr/bin/chromium";

  return chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

function configurePublicWebContext(
  context: BrowserContext,
): void {
  context.route(
    "**/*",
    async (route: Route) => {
      const requestUrl =
        route.request().url();

      if (
        requestUrl.startsWith("data:") ||
        requestUrl.startsWith("blob:")
      ) {
        await route.abort();
        return;
      }

      if (
        !requestUrl.startsWith("http://") &&
        !requestUrl.startsWith("https://")
      ) {
        await route.abort();
        return;
      }

      if (!isSafePublicUrl(requestUrl)) {
        await route.abort();
        return;
      }

      await route.continue();
    },
  );
}

async function capturePageInternal(
  page: Page,
  result: BrowserSearchResult,
  sessionPath: string,
  index: number,
  timeoutMs: number,
): Promise<BrowserPageCapture> {
  if (!isSafePublicUrl(result.url)) {
    throw new Error(
      `Unsafe public URL rejected: ${result.url}`,
    );
  }

  await page.goto(
    result.url,
    {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    },
  );

  const text =
    await extractReadableText(page);

  const screenshotFilename =
    `${String(index).padStart(2, "0")}-` +
    `${safeFilename(result.title)}.png`;

  const screenshotPath =
    path.join(
      sessionPath,
      screenshotFilename,
    );

  await fs.mkdir(
    sessionPath,
    {
      recursive: true,
    },
  );

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  return {
    title: result.title,
    url: result.url,
    description:
      result.description || "",
    text: text.slice(0, 12_000),
    screenshotPath,
    category: result.category,
    capturedAt:
      new Date().toISOString(),
  };
}

/**
 * Public capturePage compatibility API.
 *
 * Existing tools already call this function directly,
 * so this provider accepts either:
 *
 * capturePage(url)
 *
 * or:
 *
 * capturePage({
 *   url,
 *   title,
 *   description,
 *   category
 * })
 */
export async function capturePage(
  input: any,
  options: any = {},
): Promise<BrowserPageCapture> {
  const timeoutMs =
    typeof options?.timeoutMs === "number"
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const raw =
    typeof input === "string"
      ? {
          url: input,
          title: input,
          description: "",
          category:
            options?.category,
        }
      : {
          ...(input || {}),
          ...(options || {}),
        };

  if (
    typeof raw.url !== "string" ||
    !raw.url.trim()
  ) {
    throw new Error(
      "capturePage requires a URL.",
    );
  }

  const result: BrowserSearchResult = {
    title:
      typeof raw.title === "string" &&
      raw.title.trim()
        ? raw.title.trim()
        : raw.url,
    url: raw.url.trim(),
    description:
      typeof raw.description === "string"
        ? raw.description.trim()
        : "",
    category:
      normalizeCategory(
        raw.category,
      ),
  };

  const sessionPath =
    typeof raw.sessionPath === "string" &&
    raw.sessionPath.trim()
      ? raw.sessionPath
      : buildResearchSessionPath(
          result.category,
          raw.sessionId,
        );

  const browser =
    await createBrowser();

  try {
    const context =
      await browser.newContext({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) " +
          "AppleWebKit/537.36 " +
          "(KHTML, like Gecko) " +
          "Chrome/120 Safari/537.36",
        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    configurePublicWebContext(
      context,
    );

    const page =
      await context.newPage();

    const capture =
      await capturePageInternal(
        page,
        result,
        sessionPath,
        0,
        timeoutMs,
      );

    await context.close();

    return capture;
  } finally {
    await browser.close();
  }
}

/**
 * Browser-based search without an external search API key.
 */
export async function searchWeb(
  queryOrOptions: any,
): Promise<BrowserSearchResult[]> {
  const options =
    typeof queryOrOptions === "string"
      ? {}
      : queryOrOptions || {};

  const query =
    typeof queryOrOptions === "string"
      ? queryOrOptions.trim()
      : typeof options.query === "string"
        ? options.query.trim()
        : "";

  if (!query) {
    return [];
  }

  const maxResults = Math.max(
    1,
    Math.min(
      typeof options.maxResults === "number"
        ? options.maxResults
        : DEFAULT_MAX_RESULTS,
      10,
    ),
  );

  const category =
    normalizeCategory(
      options.category,
    );

  const encodedQuery =
    encodeURIComponent(query);

  const searchUrl =
    "https://html.duckduckgo.com/html/?q=" +
    encodedQuery;

  if (!isSafePublicUrl(searchUrl)) {
    throw new Error(
      "Search URL failed public-web safety validation.",
    );
  }

  const timeoutMs =
    typeof options.timeoutMs === "number"
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const browser =
    await createBrowser();

  try {
    const context =
      await browser.newContext({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) " +
          "AppleWebKit/537.36 " +
          "(KHTML, like Gecko) " +
          "Chrome/120 Safari/537.36",
        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    configurePublicWebContext(
      context,
    );

    const page =
      await context.newPage();

    await page.goto(
      searchUrl,
      {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      },
    );

    const searchResults =
      await page
        .locator("a.result__a")
        .evaluateAll(
          (anchors) =>
            anchors.map(
              (anchor) => {
                const root =
                  anchor.closest(
                    ".result",
                  );

                const snippet =
                  root?.querySelector(
                    ".result__snippet",
                  )?.textContent || "";

                return {
                  title:
                    anchor.textContent
                      ?.trim() || "",
                  href:
                    (
                      anchor as HTMLAnchorElement
                    ).href || "",
                  description:
                    snippet.trim(),
                };
              },
            ),
        );

    const results: BrowserSearchResult[] =
      [];

    for (
      const item of searchResults.slice(
        0,
        maxResults,
      )
    ) {
      const url =
        resolveSearchResultUrl(
          item.href,
          searchUrl,
        );

      if (!url) {
        continue;
      }

      results.push({
        title:
          item.title || url,
        url,
        description:
          item.description || "",
        category,
      });
    }

    await context.close();

    return results;
  } finally {
    await browser.close();
  }
}

/**
 * Full research pass:
 *
 * search -> capture selected pages -> return evidence.
 */
export async function researchWeb(
  queryOrOptions: any,
  maybeOptions: any = {},
): Promise<BrowserResearchResult> {
  const options =
    typeof queryOrOptions === "string"
      ? maybeOptions || {}
      : queryOrOptions || {};

  const query =
    typeof queryOrOptions === "string"
      ? queryOrOptions.trim()
      : typeof options.query === "string"
        ? options.query.trim()
        : "";

  if (!query) {
    return {
      query: "",
      category: normalizeCategory(
        options.category,
      ),
      results: [],
    };
  }

  const category =
    normalizeCategory(
      options.category,
    );

  const maxResults = Math.max(
    1,
    Math.min(
      typeof options.maxResults === "number"
        ? options.maxResults
        : DEFAULT_MAX_RESULTS,
      10,
    ),
  );

  const pagesToCapture = Math.max(
    0,
    Math.min(
      typeof options.pagesToCapture === "number"
        ? options.pagesToCapture
        : DEFAULT_PAGES_TO_CAPTURE,
      maxResults,
    ),
  );

  const timeoutMs =
    typeof options.timeoutMs === "number"
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const sessionPath =
    typeof options.sessionPath === "string" &&
    options.sessionPath.trim()
      ? options.sessionPath
      : buildResearchSessionPath(
          category,
          options.sessionId,
        );

  const results =
    await searchWeb({
      query,
      category,
      maxResults,
      timeoutMs,
    });

  const browser =
    await createBrowser();

  try {
    const context =
      await browser.newContext({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) " +
          "AppleWebKit/537.36 " +
          "(KHTML, like Gecko) " +
          "Chrome/120 Safari/537.36",
        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    configurePublicWebContext(
      context,
    );

    const page =
      await context.newPage();

    for (
      let index = 0;
      index < Math.min(
        pagesToCapture,
        results.length,
      );
      index += 1
    ) {
      try {
        const capture =
          await capturePageInternal(
            page,
            results[index],
            sessionPath,
            index,
            timeoutMs,
          );

        results[index] = {
          ...results[index],
          text: capture.text,
          screenshotPath:
            capture.screenshotPath,
        };
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : String(err);

        results[index] = {
          ...results[index],
          text:
            `Page capture failed: ${message}`,
        };
      }
    }

    await context.close();

    return {
      query,
      category,
      results,
      sessionPath,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Alias used by the higher-level research department.
 */
export async function searchAndCapture(
  query: string,
  options: BrowserSearchOptions = {},
): Promise<BrowserResearchResult> {
  return researchWeb(
    query,
    options,
  );
}