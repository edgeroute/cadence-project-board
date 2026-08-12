/**
 * Pulling images out of markdown so they can be shown as thumbnails rather than
 * rendered inline.
 *
 * Ported from szmidtpiotr/claude-github-issue (MIT) — see LICENSE.
 *
 * Why extract rather than render in place: a screenshot pasted into a GitHub comment
 * is full-width, and inline it would push the rest of the thread off a panel that is
 * already inside a modal. A row of thumbnails keeps the text readable and puts the
 * image one click from full size.
 *
 * `Markdown` therefore never renders an image, and callers strip them before handing
 * text to it.
 */

export interface ExtractedImage {
  alt: string;
  url: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Every image in the text, markdown and raw `<img>` alike.
 *
 * The HTML form is not an edge case: GitHub's own web composer emits `<img>` for a
 * pasted or drag-dropped screenshot, so the markdown pattern alone would miss most of
 * the images that actually appear in comments.
 */
export function extractImages(text: string): ExtractedImage[] {
  const results: ExtractedImage[] = [];
  const seen = new Set<string>();

  const add = (rawUrl: string, alt: string) => {
    if (!rawUrl) return;
    const url = decodeHtmlEntities(rawUrl);
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ alt, url });
  };

  const md = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text)) !== null) add(m[2] ?? '', m[1] ?? '');

  const html = /<img\b([^>]*)>/gi;
  while ((m = html.exec(text)) !== null) {
    const attrs = m[1] ?? '';
    const src = attrs.match(/src=["'](https?:\/\/[^"']+)["']/i);
    const alt = attrs.match(/alt=["']([^"']*)["']/i);
    if (src?.[1]) add(src[1], alt?.[1] ?? '');
  }

  return results;
}

/**
 * The same text with the images taken out.
 *
 * The `<img>` strip also covers the surrounding `<a>` GitHub wraps a screenshot in,
 * which would otherwise be left behind as a bare link to the same picture the
 * thumbnail already shows.
 */
export function stripImages(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g, '')
    .replace(/<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
