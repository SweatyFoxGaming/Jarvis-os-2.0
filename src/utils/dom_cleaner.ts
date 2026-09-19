import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Cast array to bypass HTMLElementTagNameMap type constraint for SVG elements
turndownService.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'footer', 'nav'] as any);

export function extractCleanMarkdown(html: string, url: string): { title: string; markdown: string } {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    return {
      title: dom.window.document.title || 'Untitled',
      markdown: turndownService.turndown(html).slice(0, 8000),
    };
  }

  const cleanMarkdown = turndownService.turndown(article.content);
  return {
    title: article.title || dom.window.document.title,
    markdown: cleanMarkdown,
  };
}