// Compact diff renderer for the agent thread. Mirrors the look of
// claude-code's StructuredDiffList: line numbers in a dim gutter, additions on
// green, deletions on red, no surrounding chrome.
//
// Two view modes:
//   • 'unified' (default) — single column, +/- gutter sign, hunk separators.
//   • 'split' — two parallel columns; deletions and additions in the same
//     hunk are paired side-by-side (GitHub PR style).
//
// When the caller threads both a numeric `runId` and a `filePath`, each line
// also gets a hover-revealed "+" trigger that opens a small popover for
// attaching a review comment. Comments are persisted via the review-comments
// bridge so the composer can splice them into the next message sent to the
// run. When either prop is omitted the renderer behaves exactly as before.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ReviewCommentPayload } from '../../api.js';

export type InlineDiffMode = 'unified' | 'split';

export type ReviewCommentSide = 'old' | 'new' | 'context';

interface InlineDiffProps {
  oldString: string;
  newString: string;
  // Number of unchanged lines to keep around each change, like CONTEXT_LINES
  // in claude-code's diff util.
  context?: number;
  mode?: InlineDiffMode;
  // When true, lines that differ only in whitespace are treated as equal —
  // matches `git diff -w`. The rendered text always uses the new content so
  // formatting changes don't leak through as visible diffs.
  ignoreWhitespace?: boolean;
  /**
   * When BOTH `runId` and `filePath` are supplied, the renderer enables the
   * inline-comment affordance — a "+" trigger on hover, a popover textarea
   * to add, and existing comments rendered below their line. Comments are
   * scoped to the (run, file, line, side) tuple. Cloud-string run ids
   * intentionally omit this prop; this UI is local-only for now.
   */
  runId?: number;
  filePath?: string;
}

interface DiffRow {
  kind: 'context' | 'add' | 'del' | 'hunk';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface SplitRow {
  kind: 'context' | 'change' | 'add' | 'del' | 'hunk';
  left: DiffRow | null;
  right: DiffRow | null;
  // For 'hunk' rows the marker text spans both columns.
  hunkText?: string;
}

/** Composite key for grouping comments by (line, side). Used to look up
 *  cards on each row. Format: `${lineNumber}:${side}`. */
function commentKey(lineNumber: number, side: ReviewCommentSide): string {
  return `${lineNumber}:${side}`;
}

/** What side does a unified-mode row map to when the user clicks the +
 *  trigger? Context lines pick 'new' because the post-edit file is what
 *  the agent will be reading when the comment is replayed back. Add rows
 *  → 'new'; del rows → 'old'. */
function unifiedSideForRow(row: DiffRow): ReviewCommentSide {
  if (row.kind === 'del') return 'old';
  if (row.kind === 'add') return 'new';
  return 'context';
}

/** Line number for a row + chosen side. Context rows can be addressed
 *  through either column — pick whichever matches `side`. */
function unifiedLineForRow(row: DiffRow, side: ReviewCommentSide): number | null {
  if (side === 'old') return row.oldLine;
  // Both 'new' and 'context' index against the new-file column.
  return row.newLine;
}

export function InlineDiff({
  oldString,
  newString,
  context = 3,
  mode = 'unified',
  ignoreWhitespace = false,
  runId,
  filePath,
}: InlineDiffProps) {
  const rows = useMemo(
    () => buildDiffRows(oldString, newString, context, ignoreWhitespace),
    [oldString, newString, context, ignoreWhitespace],
  );

  const commentsEnabled =
    typeof runId === 'number' &&
    Number.isFinite(runId) &&
    runId > 0 &&
    typeof filePath === 'string' &&
    filePath.length > 0;

  const [comments, setComments] = useState<ReviewCommentPayload[]>([]);
  const refresh = useCallback(async () => {
    if (!commentsEnabled) return;
    try {
      const list = await api.listReviewCommentsForFile(runId!, filePath!);
      setComments(list);
    } catch {
      // Surface failures inline on the next add/delete instead of toasting.
    }
  }, [commentsEnabled, runId, filePath]);

  useEffect(() => {
    if (!commentsEnabled) {
      setComments([]);
      return;
    }
    void refresh();
  }, [commentsEnabled, refresh]);

  const commentsByKey = useMemo(() => {
    const map = new Map<string, ReviewCommentPayload[]>();
    for (const c of comments) {
      const k = commentKey(c.lineNumber, c.side);
      const arr = map.get(k);
      if (arr) arr.push(c);
      else map.set(k, [c]);
    }
    return map;
  }, [comments]);

  if (rows.length === 0) return null;

  const oldGutter = Math.max(2, String(rows.at(-1)?.oldLine ?? 0).length);
  const newGutter = Math.max(2, String(rows.at(-1)?.newLine ?? 0).length);

  if (mode === 'split') {
    const splitRows = pairForSplit(rows);
    return (
      <div className="kb-idiff split">
        {splitRows.map((sr, i) => {
          if (sr.kind === 'hunk') {
            return (
              <div key={i} className="kb-idiff-line hunk" role="separator">
                <span className="kb-idiff-text">{sr.hunkText ?? ''}</span>
              </div>
            );
          }
          return (
            <SplitDiffRow
              key={i}
              row={sr}
              oldGutter={oldGutter}
              newGutter={newGutter}
              commentsEnabled={commentsEnabled}
              {...(commentsEnabled
                ? { runId: runId!, filePath: filePath! }
                : {})}
              commentsByKey={commentsByKey}
              onMutated={refresh}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="kb-idiff">
      {rows.map((r, i) => (
        <UnifiedDiffRow
          key={i}
          row={r}
          oldGutter={oldGutter}
          newGutter={newGutter}
          commentsEnabled={commentsEnabled}
          {...(commentsEnabled ? { runId: runId!, filePath: filePath! } : {})}
          commentsByKey={commentsByKey}
          onMutated={refresh}
        />
      ))}
    </div>
  );
}

interface UnifiedDiffRowProps {
  row: DiffRow;
  oldGutter: number;
  newGutter: number;
  commentsEnabled: boolean;
  runId?: number;
  filePath?: string;
  commentsByKey: Map<string, ReviewCommentPayload[]>;
  onMutated: () => Promise<void> | void;
}

function UnifiedDiffRow({
  row,
  oldGutter,
  newGutter,
  commentsEnabled,
  runId,
  filePath,
  commentsByKey,
  onMutated,
}: UnifiedDiffRowProps) {
  // Hunk rows are not commentable — they're synthetic separators.
  if (row.kind === 'hunk') {
    return (
      <div className="kb-idiff-line hunk" role="separator">
        <span className="kb-idiff-text">{row.text}</span>
      </div>
    );
  }
  const side = unifiedSideForRow(row);
  const lineNumber = unifiedLineForRow(row, side);
  const lookupKey =
    commentsEnabled && lineNumber !== null ? commentKey(lineNumber, side) : null;
  const lineComments =
    lookupKey !== null ? (commentsByKey.get(lookupKey) ?? []) : [];

  return (
    <>
      <div className={`kb-idiff-line ${row.kind}`}>
        <span className="kb-idiff-num" aria-hidden>
          {row.oldLine !== null
            ? String(row.oldLine).padStart(oldGutter, ' ')
            : ' '.repeat(oldGutter)}
        </span>
        <span className="kb-idiff-num" aria-hidden>
          {row.newLine !== null
            ? String(row.newLine).padStart(newGutter, ' ')
            : ' '.repeat(newGutter)}
        </span>
        <span className="kb-idiff-sign" aria-hidden>
          {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
        </span>
        <span className="kb-idiff-text">{row.text || ' '}</span>
        {commentsEnabled && lineNumber !== null ? (
          <CommentTrigger
            runId={runId!}
            filePath={filePath!}
            lineNumber={lineNumber}
            side={side}
            onAdded={onMutated}
          />
        ) : null}
      </div>
      {lineComments.length > 0 ? (
        <CommentList
          comments={lineComments}
          onRemoved={onMutated}
        />
      ) : null}
    </>
  );
}

interface SplitDiffRowProps {
  row: SplitRow;
  oldGutter: number;
  newGutter: number;
  commentsEnabled: boolean;
  runId?: number;
  filePath?: string;
  commentsByKey: Map<string, ReviewCommentPayload[]>;
  onMutated: () => Promise<void> | void;
}

function SplitDiffRow({
  row,
  oldGutter,
  newGutter,
  commentsEnabled,
  runId,
  filePath,
  commentsByKey,
  onMutated,
}: SplitDiffRowProps) {
  // For split mode the side is fixed by which column was clicked: left
  // half always means 'old', right half always means 'new'. Context rows
  // mirror the same content to both sides; we still attach independently
  // to each — most people will click the right one but either is fine.
  const leftLine = row.left?.oldLine ?? null;
  const rightLine = row.right?.newLine ?? null;
  const leftKey =
    commentsEnabled && leftLine !== null
      ? commentKey(leftLine, 'old')
      : null;
  const rightKey =
    commentsEnabled && rightLine !== null
      ? commentKey(rightLine, row.kind === 'context' ? 'context' : 'new')
      : null;
  const leftComments =
    leftKey !== null ? (commentsByKey.get(leftKey) ?? []) : [];
  const rightComments =
    rightKey !== null ? (commentsByKey.get(rightKey) ?? []) : [];
  return (
    <>
      <div className="kb-idiff-split-row">
        <SplitHalfCell
          row={row.left}
          side="old"
          gutter={oldGutter}
          commentsEnabled={commentsEnabled}
          {...(commentsEnabled
            ? { runId: runId!, filePath: filePath! }
            : {})}
          onMutated={onMutated}
          isContext={row.kind === 'context'}
        />
        <SplitHalfCell
          row={row.right}
          side="new"
          gutter={newGutter}
          commentsEnabled={commentsEnabled}
          {...(commentsEnabled
            ? { runId: runId!, filePath: filePath! }
            : {})}
          onMutated={onMutated}
          isContext={row.kind === 'context'}
        />
      </div>
      {leftComments.length > 0 || rightComments.length > 0 ? (
        <div className="kb-idiff-split-row">
          <div className="kb-idiff-comment-half">
            {leftComments.length > 0 ? (
              <CommentList comments={leftComments} onRemoved={onMutated} />
            ) : null}
          </div>
          <div className="kb-idiff-comment-half">
            {rightComments.length > 0 ? (
              <CommentList comments={rightComments} onRemoved={onMutated} />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

interface SplitHalfCellProps {
  row: DiffRow | null;
  side: 'old' | 'new';
  gutter: number;
  commentsEnabled: boolean;
  runId?: number;
  filePath?: string;
  onMutated: () => Promise<void> | void;
  /** Context rows store as side='context' regardless of which column was
   *  clicked, so adds on either half land in the same bucket. */
  isContext: boolean;
}

function SplitHalfCell({
  row,
  side,
  gutter,
  commentsEnabled,
  runId,
  filePath,
  onMutated,
  isContext,
}: SplitHalfCellProps) {
  if (row === null) {
    return <div className="kb-idiff-line empty" aria-hidden />;
  }
  const lineNum = side === 'old' ? row.oldLine : row.newLine;
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
  const commentSide: ReviewCommentSide = isContext
    ? 'context'
    : side === 'old'
      ? 'old'
      : 'new';
  return (
    <div className={`kb-idiff-line ${row.kind}`}>
      <span className="kb-idiff-num" aria-hidden>
        {lineNum !== null ? String(lineNum).padStart(gutter, ' ') : ' '.repeat(gutter)}
      </span>
      <span className="kb-idiff-sign" aria-hidden>
        {sign}
      </span>
      <span className="kb-idiff-text">{row.text || ' '}</span>
      {commentsEnabled && lineNum !== null ? (
        <CommentTrigger
          runId={runId!}
          filePath={filePath!}
          lineNumber={lineNum}
          side={commentSide}
          onAdded={onMutated}
        />
      ) : null}
    </div>
  );
}

interface CommentTriggerProps {
  runId: number;
  filePath: string;
  lineNumber: number;
  side: ReviewCommentSide;
  onAdded: () => Promise<void> | void;
}

function CommentTrigger({
  runId,
  filePath,
  lineNumber,
  side,
  onAdded,
}: CommentTriggerProps) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      // Defer to next frame so the textarea has actually mounted.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || posting) return;
    setPosting(true);
    setError(null);
    try {
      await api.addReviewComment({
        runId,
        filePath,
        lineNumber,
        side,
        body: trimmed,
      });
      setBody('');
      setOpen(false);
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }, [body, posting, runId, filePath, lineNumber, side, onAdded]);

  const cancel = useCallback(() => {
    setBody('');
    setError(null);
    setOpen(false);
  }, []);

  return (
    <span className="kb-idiff-comment-slot">
      <button
        type="button"
        className="kb-idiff-comment-trigger"
        title="Add a review comment on this line"
        aria-label={`Add a review comment on line ${lineNumber}`}
        onClick={() => setOpen((v) => !v)}
      >
        +
      </button>
      {open ? (
        <div className="kb-idiff-comment-popover" role="dialog">
          <textarea
            ref={textareaRef}
            className="kb-idiff-comment-text"
            placeholder="Leave a comment for the agent…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            disabled={posting}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
                return;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="kb-idiff-comment-actions">
            {error !== null ? (
              <span className="kb-idiff-comment-err">{error}</span>
            ) : null}
            <span className="kb-idiff-comment-hint">⌘⏎ to add</span>
            <button
              type="button"
              className="kb-btn"
              onClick={cancel}
              disabled={posting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="kb-btn primary"
              onClick={() => void submit()}
              disabled={posting || body.trim().length === 0}
            >
              {posting ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

interface CommentListProps {
  comments: ReviewCommentPayload[];
  onRemoved: () => Promise<void> | void;
}

function CommentList({ comments, onRemoved }: CommentListProps) {
  return (
    <div className="kb-idiff-comment-stack">
      {comments.map((c) => (
        <CommentCard key={c.id} comment={c} onRemoved={onRemoved} />
      ))}
    </div>
  );
}

interface CommentCardProps {
  comment: ReviewCommentPayload;
  onRemoved: () => Promise<void> | void;
}

function CommentCard({ comment, onRemoved }: CommentCardProps) {
  const [removing, setRemoving] = useState(false);
  const remove = useCallback(async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await api.removeReviewComment(comment.id);
      await onRemoved();
    } catch {
      setRemoving(false);
    }
  }, [removing, comment.id, onRemoved]);

  const consumed = comment.consumedAt !== null;
  return (
    <div
      className={`kb-idiff-comment-card${consumed ? ' kb-idiff-comment-consumed' : ''}`}
    >
      <div className="kb-idiff-comment-body">{comment.body}</div>
      <div className="kb-idiff-comment-meta">
        {consumed ? (
          <span className="kb-idiff-comment-sent" title={`sent ${comment.consumedAt}`}>
            ✓ sent
          </span>
        ) : null}
        <span className="kb-idiff-comment-time" title={comment.createdAt}>
          {formatRelative(comment.createdAt)}
        </span>
        {!consumed ? (
          <button
            type="button"
            className="kb-idiff-comment-del"
            title="Delete this comment"
            aria-label="Delete this comment"
            onClick={() => void remove()}
            disabled={removing}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Pair del runs with add runs so a "change" lines up across both columns,
// GitHub-style. Excess on either side becomes left-only or right-only rows.
// Context rows mirror to both sides; hunk markers stay full-width.
function pairForSplit(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.kind === 'context') {
      out.push({ kind: 'context', left: r, right: r });
      i++;
      continue;
    }
    if (r.kind === 'hunk') {
      out.push({ kind: 'hunk', left: null, right: null, hunkText: r.text });
      i++;
      continue;
    }
    // Greedy: gather a run of consecutive del / add rows, preserving order.
    // Dels go left, adds go right; paired index-by-index, excess unpaired.
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && (rows[i]!.kind === 'del' || rows[i]!.kind === 'add')) {
      if (rows[i]!.kind === 'del') dels.push(rows[i]!);
      else adds.push(rows[i]!);
      i++;
    }
    const pairCount = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      const left = dels[k] ?? null;
      const right = adds[k] ?? null;
      let kind: SplitRow['kind'];
      if (left !== null && right !== null) kind = 'change';
      else if (left !== null) kind = 'del';
      else kind = 'add';
      out.push({ kind, left, right });
    }
  }
  return out;
}

// Compact LCS-based line diff. The agent inputs are typically a few-line
// snippet for Edit and a whole file for Write — both stay well under the
// O(n*m) memory we use here.
function buildDiffRows(
  oldStr: string,
  newStr: string,
  context: number,
  ignoreWhitespace: boolean,
): DiffRow[] {
  const oldLines = oldStr === '' ? [] : oldStr.split('\n');
  const newLines = newStr === '' ? [] : newStr.split('\n');

  // Trailing-newline split produces a trailing '' which we drop — diff renders
  // "no newline at end of file" implicitly.
  const trimmedOld =
    oldLines.length > 0 && oldLines.at(-1) === '' ? oldLines.slice(0, -1) : oldLines;
  const trimmedNew =
    newLines.length > 0 && newLines.at(-1) === '' ? newLines.slice(0, -1) : newLines;

  const ops = lcsDiff(trimmedOld, trimmedNew, ignoreWhitespace);

  // Collapse runs of unchanged lines beyond the context window into "hunk"
  // separators so large unchanged blocks don't dominate the diff card.
  const rows: DiffRow[] = [];
  let oldNum = 0;
  let newNum = 0;
  // Compute, for each op index, distance to nearest non-equal op so we can
  // decide which equal-runs to keep.
  const distanceToChange: number[] = new Array(ops.length).fill(Infinity);
  let last = -Infinity;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== 'eq') last = i;
    distanceToChange[i] = i - last;
  }
  let next = Infinity;
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i]!.kind !== 'eq') next = i;
    distanceToChange[i] = Math.min(distanceToChange[i]!, next - i);
  }

  let pendingHunkBreak = false;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const showLine = op.kind !== 'eq' || distanceToChange[i]! <= context;
    if (op.kind === 'eq') {
      oldNum++;
      newNum++;
      if (!showLine) {
        pendingHunkBreak = true;
        continue;
      }
      if (pendingHunkBreak) {
        rows.push({ kind: 'hunk', oldLine: null, newLine: null, text: `@@ -${oldNum} +${newNum} @@` });
        pendingHunkBreak = false;
      }
      rows.push({ kind: 'context', oldLine: oldNum, newLine: newNum, text: op.text });
    } else if (op.kind === 'del') {
      if (pendingHunkBreak) {
        rows.push({ kind: 'hunk', oldLine: null, newLine: null, text: `@@ -${oldNum + 1} +${newNum + 1} @@` });
        pendingHunkBreak = false;
      }
      oldNum++;
      rows.push({ kind: 'del', oldLine: oldNum, newLine: null, text: op.text });
    } else {
      if (pendingHunkBreak) {
        rows.push({ kind: 'hunk', oldLine: null, newLine: null, text: `@@ -${oldNum + 1} +${newNum + 1} @@` });
        pendingHunkBreak = false;
      }
      newNum++;
      rows.push({ kind: 'add', oldLine: null, newLine: newNum, text: op.text });
    }
  }
  return rows;
}

interface DiffOp {
  kind: 'eq' | 'add' | 'del';
  text: string;
}

function lcsDiff(a: string[], b: string[], ignoreWhitespace: boolean): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // Comparison keys — when ignoring whitespace, strip ALL whitespace so
  // formatting-only changes fold into 'eq'. Matches `git diff -w`.
  const aKey = ignoreWhitespace ? a.map(stripWs) : a;
  const bKey = ignoreWhitespace ? b.map(stripWs) : b;
  // Simple O(n*m) DP — good enough for the snippets the agent edits at a time.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aKey[i] === bKey[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aKey[i] === bKey[j]) {
      // Lines are considered equal — display the *new* text so formatting
      // changes don't surface as visible context lines.
      ops.push({ kind: 'eq', text: b[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++]! });
  while (j < m) ops.push({ kind: 'add', text: b[j++]! });
  return ops;
}

function stripWs(s: string): string {
  return s.replace(/\s+/g, '');
}
