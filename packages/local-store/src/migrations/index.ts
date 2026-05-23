import { migration as m0001 } from './0001-initial.js';
import { migration as m0002 } from './0002-agent-session.js';
import { migration as m0003 } from './0003-local-issues.js';
import { migration as m0004 } from './0004-agent-model.js';
import { migration as m0005 } from './0005-workspaces-folders.js';
import { migration as m0006 } from './0006-agent-cost.js';
import { migration as m0007 } from './0007-agent-checks.js';
import { migration as m0008 } from './0008-agent-preview.js';
import { migration as m0009 } from './0009-autopilot-sessions.js';
import { migration as m0010 } from './0010-sentry.js';
import { migration as m0011 } from './0011-agent-stop-escalation.js';
import { migration as m0012 } from './0012-cost-budget.js';
import { migration as m0013 } from './0013-providers.js';
import { migration as m0014 } from './0014-agent-run-provider.js';
import { migration as m0015 } from './0015-thread-last-model.js';
import { migration as m0016 } from './0016-chat-conversations.js';
import { migration as m0017 } from './0017-codex-cli-provider.js';
import { migration as m0018 } from './0018-remove-api-key-providers.js';
import { migration as m0020 } from './0020-run-analytics.js';
import { migration as m0021 } from './0021-learnings.js';
import { migration as m0022 } from './0022-diff-hunks.js';
import { migration as m0023 } from './0023-review-comments.js';
import type { Migration } from './types.js';

// 0019-project-scope.ts is intentionally not imported here — it scaffolds
// the cloud-sync columns/tables but no code reads them yet. Wire it in when
// the cloud edition lands. New migrations bump past 0019 to preserve future
// numbering.

export const migrations: readonly Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0020,
  m0021,
  m0022,
  m0023,
];

export type { Migration };
