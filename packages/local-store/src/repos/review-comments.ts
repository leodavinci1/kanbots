import type { Db } from '../db.js';
import type { AgentRunId } from '../types.js';

export type ReviewCommentSide = 'old' | 'new' | 'context';

export interface ReviewComment {
  id: number;
  runId: number;
  filePath: string;
  lineNumber: number;
  side: ReviewCommentSide;
  body: string;
  createdAt: string;
  consumedAt: string | null;
}

interface ReviewCommentRow {
  id: number;
  run_id: number;
  file_path: string;
  line_number: number;
  side: string;
  body: string;
  created_at: string;
  consumed_at: string | null;
}

function rowToComment(row: ReviewCommentRow): ReviewComment {
  return {
    id: row.id,
    runId: row.run_id,
    filePath: row.file_path,
    lineNumber: row.line_number,
    side: row.side as ReviewCommentSide,
    body: row.body,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

export interface ListReviewCommentsInput {
  runId: AgentRunId;
  /** When false (the default), unsent comments only. When true, includes
   *  comments that have already been handed to the agent so the UI can
   *  render them greyed-out below their line. */
  includeConsumed?: boolean;
}

export interface ListReviewCommentsForFileInput {
  runId: AgentRunId;
  filePath: string;
}

export interface AddReviewCommentInput {
  runId: AgentRunId;
  filePath: string;
  lineNumber: number;
  side: ReviewCommentSide;
  body: string;
}

export class ReviewCommentsRepo {
  constructor(private readonly db: Db) {}

  list(input: ListReviewCommentsInput): ReviewComment[] {
    const includeConsumed = input.includeConsumed ?? false;
    const rows = includeConsumed
      ? (this.db
          .prepare(
            `SELECT * FROM review_comments
             WHERE run_id = ?
             ORDER BY file_path, line_number, id`,
          )
          .all(input.runId) as ReviewCommentRow[])
      : (this.db
          .prepare(
            `SELECT * FROM review_comments
             WHERE run_id = ? AND consumed_at IS NULL
             ORDER BY file_path, line_number, id`,
          )
          .all(input.runId) as ReviewCommentRow[]);
    return rows.map(rowToComment);
  }

  listForFile(input: ListReviewCommentsForFileInput): ReviewComment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM review_comments
         WHERE run_id = ? AND file_path = ?
         ORDER BY line_number, id`,
      )
      .all(input.runId, input.filePath) as ReviewCommentRow[];
    return rows.map(rowToComment);
  }

  add(input: AddReviewCommentInput): ReviewComment {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO review_comments
          (run_id, file_path, line_number, side, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.filePath,
        input.lineNumber,
        input.side,
        input.body,
        createdAt,
      );
    const row = this.db
      .prepare('SELECT * FROM review_comments WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as ReviewCommentRow;
    return rowToComment(row);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM review_comments WHERE id = ?').run(id);
  }

  findById(id: number): ReviewComment | null {
    const row = this.db
      .prepare('SELECT * FROM review_comments WHERE id = ?')
      .get(id) as ReviewCommentRow | undefined;
    return row ? rowToComment(row) : null;
  }

  /**
   * Mark every unsent comment on this run as consumed, atomically. Returns
   * the rows that were just marked so the caller (the composer) can render
   * what was attached. If nothing was pending, returns [] and writes nothing.
   */
  consumePending(runId: AgentRunId): ReviewComment[] {
    const now = new Date().toISOString();
    const txn = this.db.transaction((): ReviewComment[] => {
      const pending = this.db
        .prepare(
          `SELECT * FROM review_comments
           WHERE run_id = ? AND consumed_at IS NULL
           ORDER BY file_path, line_number, id`,
        )
        .all(runId) as ReviewCommentRow[];
      if (pending.length === 0) return [];
      this.db
        .prepare(
          `UPDATE review_comments SET consumed_at = ?
           WHERE run_id = ? AND consumed_at IS NULL`,
        )
        .run(now, runId);
      // Re-read to pick up the consumed_at value rather than synthesising it.
      const ids = pending.map((p) => p.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT * FROM review_comments WHERE id IN (${placeholders})
           ORDER BY file_path, line_number, id`,
        )
        .all(...ids) as ReviewCommentRow[];
      return rows.map(rowToComment);
    });
    return txn();
  }
}
