import { Fragment, type ReactNode } from "react";

/**
 * Minimal markdown for chat replies — bold, italic, inline code, and bullet or
 * numbered lists. Built as React elements rather than innerHTML, so model output
 * can never inject markup.
 *
 * Deliberately not a full parser: the assistant is instructed to write short
 * prose with light emphasis, and everything beyond that (tables, links, block
 * quotes, headings) would be wrong in a chat bubble anyway. Headings are
 * downgraded to bold text rather than dropped, so nothing silently disappears.
 */

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|(?<![a-zA-Z0-9])_[^_\n]+_|`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let n = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > cursor) out.push(text.slice(cursor, at));

    const token = match[0];
    const key = `${keyPrefix}i${n++}`;
    if (token.startsWith("**") || token.startsWith("__")) {
      out.push(
        <strong key={key} className="font-semibold text-ink-1">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = at + token.length;
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/** Single newlines inside a paragraph are line breaks, not word joins. */
function renderLines(lines: string[], keyPrefix: string): ReactNode[] {
  return lines.map((line, i) => (
    <Fragment key={`${keyPrefix}l${i}`}>
      {i > 0 ? <br /> : null}
      {renderInline(line, `${keyPrefix}l${i}`)}
    </Fragment>
  ));
}

const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

type RunKind = "ul" | "ol" | "p";
type Run = { kind: RunKind; lines: string[] };

const kindOf = (line: string): RunKind =>
  BULLET.test(line) ? "ul" : ORDERED.test(line) ? "ol" : "p";

/**
 * A block is not necessarily one thing. The model routinely writes a lead-in
 * line and its list with no blank line between them:
 *
 *   A couple of things worth knowing:
 *   - the Blake ships with the footrest
 *
 * Treating the block as a unit meant "not every line is a bullet", so the whole
 * thing fell through to a paragraph and the hyphens rendered literally. So split
 * each block into consecutive runs of the same kind and render them separately.
 */
function toRuns(lines: string[]): Run[] {
  const runs: Run[] = [];
  for (const line of lines) {
    const kind = kindOf(line);
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.lines.push(line);
    else runs.push({ kind, lines: [line] });
  }
  return runs;
}

function renderRun(run: Run, key: string): ReactNode {
  if (run.kind === "ul" || run.kind === "ol") {
    const List = run.kind === "ul" ? "ul" : "ol";
    const strip = run.kind === "ul" ? BULLET : ORDERED;
    return (
      <List
        key={key}
        className={`list-outside space-y-1 pl-5 ${
          run.kind === "ul" ? "list-disc" : "list-decimal"
        }`}
      >
        {run.lines.map((line, i) => (
          <li key={`${key}li${i}`}>{renderInline(line.replace(strip, ""), `${key}${i}`)}</li>
        ))}
      </List>
    );
  }

  // Headings would be wrong in a chat bubble, so they render as bold text —
  // downgraded rather than dropped, so no content silently disappears.
  if (run.lines.length === 1 && HEADING.test(run.lines[0]!)) {
    return (
      <p key={key} className="font-semibold text-ink-1">
        {renderInline(run.lines[0]!.replace(HEADING, ""), key)}
      </p>
    );
  }

  return <p key={key}>{renderLines(run.lines, key)}</p>;
}

function renderBlock(block: string, index: number): ReactNode {
  const lines = block.split("\n").filter((l) => l.trim().length > 0);
  if (!lines.length) return null;
  const runs = toRuns(lines);
  return runs.map((run, i) => renderRun(run, `b${index}r${i}`));
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink-1">{blocks.map(renderBlock)}</div>
  );
}
