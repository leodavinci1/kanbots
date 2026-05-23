import type { Migration } from './types.js';

/**
 * Inline diff review comments — a user, while inspecting a worktree diff,
 * can attach a free-text note to a specific (file, line, side) and have
 * those notes accumulate locally until the chat composer prepends them
 * to the next message sent to the run.
 *
 * `consumed_at` is the ISO timestamp at which the comment was handed off
 * to the agent (i.e. spliced into a user message). Unsent rows are NULL.
 *
 * `side` records which column the user clicked on a split diff so we can
 * render the comment back in the same position. Unified-mode context
 * lines use 'new' by convention — they belong to the post-edit file
 * which is what the agent will be looking at.
 */
export const migration: Migration = {
  id: '0023_review_comments',
  up: `
    CREATE TABLE review_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('old','new','context')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_review_comments_run ON review_comments(run_id, consumed_at);
    CREATE INDEX idx_review_comments_file ON review_comments(run_id, file_path, line_number);
  `,
};
