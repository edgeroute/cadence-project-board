import React from 'react';

/**
 * A dependency-free Markdown → React renderer for the GitHub-flavoured subset that
 * turns up in issue bodies and comments.
 *
 * Ported from szmidtpiotr/claude-github-issue (MIT) — see LICENSE. The block parser,
 * the inline "find the earliest match" loop and the table/blockquote handling are
 * theirs; the changes are listed at the bottom of this comment.
 *
 * ## Why not a markdown library
 *
 * Because the output of one has to be sanitised. `marked` + `dompurify` is ~60KB into
 * a bundle that is committed to git, and it renders to HTML that then needs
 * `dangerouslySetInnerHTML`. This builds React elements directly, so there is no HTML
 * string at any point and no injection surface to sanitise: a `<script>` in an issue
 * body is text, because the only thing this can produce is a React text node.
 *
 * ## What it deliberately does not do
 *
 * Nested lists, reference links, footnotes, HTML passthrough. Issue bodies use them
 * rarely, each costs real parser complexity, and "Open on GitHub" is one click away
 * for anything this renders imperfectly.
 *
 * ## Changes from the original
 *
 * - **Intraword underscores no longer italicise.** `_([^_]+)_` matches inside
 *   `snake_case_name`, so `plan_day_id` rendered as "plan*day*id". On a board of
 *   engineering issues that is not an edge case. Guarded by a predicate on the match
 *   rather than a lookbehind, because a regex the engine cannot parse takes the whole
 *   bundle down at load rather than degrading one italic.
 * - **Task lists render as checkboxes.** `- [ ]` and `- [x]` were drawn as literal
 *   brackets. The tracking issues on this board are mostly checklists.
 * - **Bare URLs autolink**, which is most of how links actually appear in comments.
 * - **Blockquotes keep their line breaks** instead of being joined with spaces.
 */

type Key = string | number;

interface InlinePattern {
  re: RegExp;
  /** Rejects a match the pattern found but should not claim — see the underscore note. */
  accept?: (text: string, m: RegExpExecArray) => boolean;
  render: (m: RegExpExecArray, k: string) => React.ReactNode;
  /** A global clone of `re`, built once on first use so `lastIndex` can be walked. */
  scan?: RegExp;
}

/**
 * The first match of `p` in `text` that `p.accept` is happy with.
 *
 * The obvious implementation — take the first match, drop the pattern if it is
 * rejected — is wrong, and wrong in a way that only shows on realistic text: in
 * "`plan_day_id` and _real italic_", the underscore pattern's first match is `_day_`
 * inside the identifier. Rejecting that and abandoning the pattern loses the genuine
 * emphasis later in the same line, so a paragraph mentioning one snake_case name
 * silently stops rendering italics from there on.
 *
 * So a rejected match advances past itself and the search continues, which is what
 * "the first *acceptable* match" has to mean.
 */
function firstAccepted(p: InlinePattern, text: string): RegExpExecArray | null {
  if (!p.accept) return p.re.exec(text);
  if (!p.scan) p.scan = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
  p.scan.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = p.scan.exec(text)) !== null) {
    if (p.accept(text, m)) return m;
    // A zero-length match would leave lastIndex where it is and spin; these patterns
    // cannot produce one, and this costs nothing to be certain of.
    if (m.index === p.scan.lastIndex) p.scan.lastIndex++;
  }
  return null;
}

/**
 * What counts as "welded to a word" either side of an emphasis delimiter.
 *
 * `_` is in the set, which is not obvious. Without it, `FOO__BAR__BAZ` has its bold
 * correctly rejected as intraword and then the *inner* `_BAR_` accepted as italic,
 * because the characters either side of it are underscores and underscores were not
 * word characters. Including it states the actual rule: an underscore next to another
 * underscore is not a delimiter.
 */
const WORD = /[A-Za-z0-9_]/;

/** True when the match is not welded to a word on either side. */
function standalone(text: string, m: RegExpExecArray): boolean {
  const before = m.index > 0 ? text[m.index - 1] : '';
  const after = text[m.index + m[0].length] ?? '';
  return !WORD.test(before) && !WORD.test(after);
}

const INLINE: InlinePattern[] = [
  // Code first: its contents are literal and must not be re-parsed.
  { re: /`([^`]+)`/, render: (m, k) => <code key={k} className="cpb-md-code">{m[1]}</code> },
  {
    re: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/,
    render: (m, k) => (
      <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer" className="cpb-md-link">
        {m[1]}
      </a>
    )
  },
  // A bare URL, after the labelled form above so `[text](url)` is not eaten by it.
  // The trailing class excludes `.,;:)]}` so a link ending a sentence keeps its
  // punctuation outside the anchor.
  {
    re: /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/,
    render: (m, k) => (
      <a key={k} href={m[0]} target="_blank" rel="noopener noreferrer" className="cpb-md-link">
        {m[0]}
      </a>
    )
  },
  { re: /\*\*([^*]+)\*\*/, render: (m, k) => <strong key={k}>{renderInline(m[1], k)}</strong> },
  { re: /__([^_]+)__/, accept: standalone, render: (m, k) => <strong key={k}>{renderInline(m[1], k)}</strong> },
  { re: /~~([^~]+)~~/, render: (m, k) => <del key={k}>{renderInline(m[1], k)}</del> },
  { re: /\*([^*]+)\*/, render: (m, k) => <em key={k}>{renderInline(m[1], k)}</em> },
  { re: /_([^_]+)_/, accept: standalone, render: (m, k) => <em key={k}>{renderInline(m[1], k)}</em> }
];

function renderInline(text: string, keyPrefix: Key): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let i = 0;
  // A pattern that keeps matching something it then rejects would spin forever, so a
  // rejected match advances past it rather than retrying from the same offset.
  let guard = 0;

  while (remaining.length > 0 && guard++ < 5000) {
    let best: { index: number; match: RegExpExecArray; p: InlinePattern } | null = null;
    for (const p of INLINE) {
      const m = firstAccepted(p, remaining);
      if (!m) continue;
      if (best === null || m.index < best.index) best = { index: m.index, match: m, p };
    }

    if (!best) {
      nodes.push(remaining);
      break;
    }
    if (best.index > 0) nodes.push(remaining.slice(0, best.index));
    nodes.push(best.p.render(best.match, `${keyPrefix}-i${i++}`));
    remaining = remaining.slice(best.index + best.match[0].length);
  }
  if (guard >= 5000) nodes.push(remaining);
  return nodes;
}

/**
 * Text with `\n` turned into real breaks, for paragraphs and blockquotes.
 *
 * Built by pushing into an annotated array rather than by nested `flatMap`. The
 * flatMap form types each branch separately — `(string | Element)[]` against
 * `ReactNode[]` — and TypeScript unifies them into something it will not then accept
 * as `ReactNode[]`. This is the same output, and it says what it returns.
 */
function withBreaks(nodes: React.ReactNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  nodes.forEach((node, ni) => {
    if (typeof node !== 'string') {
      out.push(node);
      return;
    }
    const segments = node.split('\n');
    segments.forEach((seg, si) => {
      out.push(seg);
      if (si < segments.length - 1) out.push(<br key={`br-${ni}-${si}`} />);
    });
  });
  return out;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*\d+\.\s+/;
const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+/;

export const Markdown: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  const startsBlock = (line: string, next: string | undefined): boolean =>
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^\s*>\s?/.test(line) ||
    ORDERED.test(line) ||
    BULLET.test(line) ||
    (line.includes('|') && next !== undefined && isTableSeparator(next));

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="cpb-md-pre">
          <code>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(
        <Tag key={key++} className={`cpb-md-h cpb-md-h${level}`}>
          {renderInline(heading[2], key)}
        </Tag>
      );
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="cpb-md-hr" />);
      i++;
      continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i++]));
      }
      blocks.push(
        <div key={key++} className="cpb-md-table-wrap">
          <table className="cpb-md-table">
            <thead>
              <tr>{header.map((c, ci) => <th key={ci}>{renderInline(c, `${key}-th${ci}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, `${key}-td${ri}-${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={key++} className="cpb-md-quote">
          {withBreaks(renderInline(quote.join('\n'), key))}
        </blockquote>
      );
      continue;
    }

    // Task list — checked before the plain bullet, which would otherwise claim it and
    // render the brackets as text.
    if (TASK.test(line)) {
      const items: React.ReactNode[] = [];
      let li = 0;
      while (i < lines.length && TASK.test(lines[i])) {
        const m = TASK.exec(lines[i])!;
        const done = m[1].toLowerCase() === 'x';
        const content = lines[i].replace(TASK, '');
        items.push(
          <li key={li++} className={`cpb-md-task${done ? ' cpb-md-task--done' : ''}`}>
            {/* Not an <input>: this is a rendering of what the issue says, and a
                checkbox that looks operable but writes nothing is a worse lie than a
                glyph. Editing the body is what GitHub is for. */}
            <span className="cpb-md-tick" aria-hidden="true">{done ? '☑' : '☐'}</span>
            <span>{renderInline(content, `${key}-t${li}`)}</span>
          </li>
        );
        i++;
      }
      blocks.push(<ul key={key++} className="cpb-md-ul cpb-md-tasks">{items}</ul>);
      continue;
    }

    if (ORDERED.test(line)) {
      const items: React.ReactNode[] = [];
      let li = 0;
      while (i < lines.length && ORDERED.test(lines[i])) {
        items.push(<li key={li++}>{renderInline(lines[i].replace(ORDERED, ''), `${key}-ol${li}`)}</li>);
        i++;
      }
      blocks.push(<ol key={key++} className="cpb-md-ol">{items}</ol>);
      continue;
    }

    if (BULLET.test(line)) {
      const items: React.ReactNode[] = [];
      let li = 0;
      while (i < lines.length && BULLET.test(lines[i]) && !TASK.test(lines[i])) {
        items.push(<li key={li++}>{renderInline(lines[i].replace(BULLET, ''), `${key}-ul${li}`)}</li>);
        i++;
      }
      blocks.push(<ul key={key++} className="cpb-md-ul">{items}</ul>);
      continue;
    }

    // Paragraph — everything up to the next blank line or block opener.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i++]);
    }
    if (para.length > 0) {
      blocks.push(
        <p key={key++} className="cpb-md-p">
          {withBreaks(renderInline(para.join('\n'), key))}
        </p>
      );
    } else {
      // `startsBlock` said yes but no branch above claimed it. Emitting the line as
      // text and advancing is what stops that becoming an infinite loop.
      blocks.push(<p key={key++} className="cpb-md-p">{lines[i]}</p>);
      i++;
    }
  }

  return <div className={`cpb-md${className ? ' ' + className : ''}`}>{blocks}</div>;
};
