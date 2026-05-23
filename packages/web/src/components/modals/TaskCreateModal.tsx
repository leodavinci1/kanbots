import { Logo } from '../Logo.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api } from '../../api.js';
import { CardPreview } from '../Card.js';
import { ModelPicker } from '../forms/ModelPicker.js';
import { dispatchIssuesRefetch } from '../../hooks/useIssues.js';
import type { Issue } from '../../types.js';

type Mode = 'spec' | 'dispatch' | 'queue';
type Tag = 'feat' | 'fix' | 'chore' | 'infra' | 'docs';
type Priority = 'p0' | 'p1' | 'p2' | 'p3';
// Legacy local type kept for downstream compat — the picker now drives
// `selection: { provider, model }` as a free-form string pair.
type Assignee = 'claude' | 'me';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Template = 'bug' | 'feature' | 'refactor' | 'review' | 'spike';

interface ModeDef {
  id: Mode;
  glyph: string;
  name: string;
  desc: string;
  hint: string;
  submitLabel: string;
}

const MODES: ModeDef[] = [
  {
    id: 'spec',
    glyph: '✎',
    name: 'Spec first',
    desc: 'Run /spec to refine acceptance criteria. Wait for my approval.',
    hint: 'Will create a worktree and run /spec — agent waits for approval.',
    submitLabel: 'Create & spec',
  },
  {
    id: 'dispatch',
    glyph: '▶',
    name: 'Create & dispatch',
    desc: 'Spawn the agent immediately on a fresh worktree.',
    hint: 'Will create a worktree and start coding immediately.',
    submitLabel: 'Create & dispatch',
  },
  {
    id: 'queue',
    glyph: '◷',
    name: 'Queue for later',
    desc: "Sit in the Backlog. I'll start it manually.",
    hint: 'Will land in Backlog. No worktree until you start it.',
    submitLabel: 'Create task',
  },
];

const TEMPLATES: Array<{ id: Template; icon: string; name: string }> = [
  { id: 'bug', icon: '!', name: 'Bug fix' },
  { id: 'feature', icon: '+', name: 'Feature' },
  { id: 'refactor', icon: '~', name: 'Refactor' },
  { id: 'review', icon: '?', name: 'Review' },
  { id: 'spike', icon: '*', name: 'Spike' },
];

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'task'
  );
}

const SPEC_SYSTEM_PROMPT = `You are running in /spec mode for a kanbots task.

1. Read the user's request below (description / scope / acceptance criteria).
2. Investigate the affected files via Read / Glob / Grep.
3. Refine the acceptance criteria into a concrete, testable list.
4. Emit a single decision card asking the user to approve the AC list before any code is written:

\`\`\`kanbots-decision
{
  "question": "Approve this acceptance criteria list?",
  "options": [
    {"value": "approve", "label": "Approve and start implementation"},
    {"value": "edit", "label": "Edit the criteria"},
    {"value": "cancel", "label": "Cancel the task"}
  ]
}
\`\`\`

After emitting the decision, end your turn — do not write any code.`;

export interface TaskCreateModalProps {
  onClose: () => void;
  onCreated?: (issue: Issue) => void;
  defaultMode?: Mode;
  initialDescription?: string;
}

export function TaskCreateModal({
  onClose,
  onCreated,
  defaultMode = 'spec',
  initialDescription = '',
}: TaskCreateModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState(initialDescription);
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [tpl, setTpl] = useState<Template>('feature');
  const [assignee, setAssignee] = useState<Assignee>('claude');
  const [modelSelection, setModelSelection] =
    useState<import('../forms/ModelPicker.js').ModelPickerValue | null>(null);
  const model = modelSelection?.model ?? 'opus';
  const [effort, setEffort] = useState<Effort>('medium');
  const [tag, setTag] = useState<Tag>('feat');
  const [priority, setPriority] = useState<Priority>('p2');
  const [checks, setChecks] = useState({
    tsc: false,
    tests: false,
    lint: false,
    e2e: false,
    preview: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [pasting, setPasting] = useState(0);

  const insertAtCursor = useCallback((insert: string): void => {
    setBody((prev) => {
      const ta = bodyRef.current;
      if (!ta) return prev + insert;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + insert + prev.slice(end);
      const cursor = start + insert.length;
      queueMicrotask(() => {
        if (bodyRef.current) {
          bodyRef.current.focus();
          bodyRef.current.setSelectionRange(cursor, cursor);
        }
      });
      return next;
    });
  }, []);

  const replaceText = useCallback((from: string, to: string): void => {
    setBody((prev) => (prev.includes(from) ? prev.replace(from, to) : prev));
  }, []);

  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images: File[] = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
    if (images.length === 0) return;
    e.preventDefault();
    for (const file of images) {
      const token = `![uploading image…](kanbots-pending:${Date.now()}-${Math.random().toString(36).slice(2, 8)})`;
      insertAtCursor(token);
      setPasting((n) => n + 1);
      try {
        const result = await api.uploadAttachment(file);
        const alt = file.name?.trim() || 'pasted image';
        replaceText(token, `![${alt}](${result.absolutePath})`);
      } catch (err) {
        replaceText(token, '');
        setError(
          `Failed to upload pasted image: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPasting((n) => Math.max(0, n - 1));
      }
    }
  }

  const branchName = useMemo(() => `claude/${slugify(title || 'untitled')}`, [title]);
  const previewIssue: Issue = useMemo(
    () => ({
      number: 0,
      title: title || 'Untitled task',
      body,
      state: 'open',
      labels: [
        `type:${tag}`,
        `priority:${priority}`,
        mode === 'queue' ? 'status:backlog' : mode === 'spec' ? 'status:todo' : 'status:in-progress',
      ],
      assignees: assignee === 'claude' ? [] : ['you'],
      user: { login: 'you', avatarUrl: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      htmlUrl: '',
      isPullRequest: false,
      status: mode === 'queue' ? 'backlog' : mode === 'spec' ? 'todo' : 'inProgress',
      agent: mode === 'dispatch' ? 'running' : mode === 'spec' ? 'queued' : 'idle',
      activeRun:
        mode === 'dispatch' || mode === 'spec'
          ? {
              id: 0,
              status: mode === 'spec' ? 'awaiting_input' : 'running',
              branch: branchName,
              model,
              startedAt: new Date().toISOString(),
              currentTool: mode === 'dispatch' ? 'Read' : null,
              currentArg: mode === 'dispatch' ? 'preparing worktree…' : null,
              totalCostUsd: null,
              pendingDecision: null,
              checks: null,
              previewUrl: null,
              previewState: null,
            }
          : null,
      sentryMeta: null,
    }),
    [title, body, tag, priority, mode, assignee, model, branchName],
  );

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const modeDef = MODES.find((m) => m.id === mode) ?? MODES[0]!;

  async function submit(e?: FormEvent): Promise<void> {
    if (e) e.preventDefault();
    if (submitting) return;
    if (pasting > 0) {
      setError('Wait for the pasted image upload to finish');
      return;
    }
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const labels = [
        `type:${tag}`,
        `priority:${priority}`,
        mode === 'queue'
          ? 'status:backlog'
          : mode === 'spec'
            ? 'status:todo'
            : 'status:in-progress',
        ...(mode === 'dispatch' ? ['agent:running'] : mode === 'spec' ? ['agent:queued'] : []),
      ];
      const created = await api.createIssue({
        title: title.trim(),
        body: body.trim(),
        labels,
        ...(assignee === 'me' ? { assignees: ['you'] } : {}),
      });
      onCreated?.(created);

      if (mode === 'spec' || mode === 'dispatch') {
        // Drop a kickoff message into the thread so the agent has a prompt.
        const kickoff =
          (body.trim() ? `${body.trim()}\n\n` : '') +
          (mode === 'spec'
            ? 'Refine the acceptance criteria first via /spec.'
            : 'Implement this task. Run typecheck after each major edit.');
        const messageRes = await api.postMessage(created.number, kickoff, { dispatch: false });
        if (!messageRes.thread) {
          throw new Error(`Could not initialise thread for issue #${created.number}`);
        }
        const threadId = messageRes.thread.id;
        await api.startAgent(created.number, {
          threadId,
          prompt: kickoff,
          ...(modelSelection
            ? { model: modelSelection.model, provider: modelSelection.provider }
            : { model }),
          ...(mode === 'spec' ? { appendSystemPrompt: SPEC_SYSTEM_PROMPT } : {}),
        });
        // Cloud mode: onCreated above fired before the run row existed on
        // the server, so the card's latest_run was still null when the
        // parent refetched. Trigger another refresh now that startAgent
        // has returned so the agent badge ("running"/"queued") shows up.
        dispatchIssuesRefetch();
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  async function submitAsDraft(): Promise<void> {
    if (submitting || !title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const labels = [`type:${tag}`, `priority:${priority}`, 'status:backlog', 'agent:idle'];
      const created = await api.createIssue({
        title: title.trim(),
        body: body.trim(),
        labels,
        ...(assignee === 'me' ? { assignees: ['you'] } : {}),
      });
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  function onTitleKey(e: KeyboardEvent<HTMLInputElement>): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="kb-modal-scrim kb-app" onClick={onClose} role="dialog" aria-modal="true">
      <div className="kb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="kb-modal-head">
          <Logo size={11} withWordmark />
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <h2>New task</h2>
          <span className="grow" />
          <span style={{ color: 'var(--ink-3)', fontSize: 11.5 }}>
            Press <span className="kb-kbd">⌘↵</span> to create
          </span>
          <button type="button" className="x-btn" onClick={onClose} aria-label="Close">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-modal-body">
          <main className="kb-modal-main">
            <form className="kb-tcm-content" onSubmit={(e) => void submit(e)}>
              {/* TITLE */}
              <div className="kb-field">
                <label className="kb-field-label">
                  Title
                  <span className="kb-field-hint">→ becomes branch + PR title</span>
                </label>
                <input
                  className="kb-input title-input"
                  placeholder="e.g. Replace password login with passkey-first onboarding"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={onTitleKey}
                  autoFocus
                />
                {title ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11,
                      color: 'var(--ink-3)',
                      minWidth: 0,
                    }}
                  >
                    <span style={{ color: 'var(--ink-4)', flexShrink: 0 }}>branch will be</span>
                    <span
                      style={{
                        fontFamily: 'var(--ff-mono)',
                        color: 'var(--accent)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                      title={branchName}
                    >
                      {branchName}
                    </span>
                  </div>
                ) : null}
              </div>

              {/* TEMPLATE */}
              <div className="kb-field">
                <label className="kb-field-label">Template</label>
                <div className="kb-templates">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`kb-tpl${tpl === t.id ? ' on' : ''}`}
                      onClick={() => setTpl(t.id)}
                    >
                      <span className="kb-ico">{t.icon}</span>
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* DESCRIPTION */}
              <div className="kb-field">
                <label className="kb-field-label">
                  Description
                  <span className="kb-field-hint">Markdown · use AC: for acceptance criteria</span>
                </label>
                <textarea
                  ref={bodyRef}
                  className="kb-textarea"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onPaste={(e) => void handlePaste(e)}
                  placeholder={`What is the user-facing outcome?\n\nAC:\n- A new user can register a passkey on first login\n- Existing users see a banner with passkey CTA\n\nTip: paste an image (⌘V / Ctrl+V) to attach it.`}
                />
                {pasting > 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                    Uploading {pasting} image{pasting === 1 ? '' : 's'}…
                  </div>
                ) : null}
              </div>

              {/* MODE */}
              <div className="kb-field">
                <label className="kb-field-label">How should this start?</label>
                <div className="kb-modes">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`kb-mode-card${mode === m.id ? ' on' : ''}`}
                      onClick={() => setMode(m.id)}
                    >
                      <div className="kb-mode-radio" aria-hidden />
                      <div className="kb-mode-glyph" aria-hidden>
                        {m.glyph}
                      </div>
                      <div className="kb-mode-name">{m.name}</div>
                      <div className="kb-mode-desc">{m.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* AGENT */}
              <div className="kb-field">
                <label className="kb-field-label">Agent</label>
                <div className="kb-sub-grid">
                  <label className="kb-pill-select">
                    <span className="lbl">assignee</span>
                    <select
                      value={assignee}
                      onChange={(e) => setAssignee(e.target.value as Assignee)}
                      className="kb-pill-select-native"
                    >
                      <option value="claude">claude (auto)</option>
                      <option value="me">me (manual)</option>
                    </select>
                    <span className="caret">▾</span>
                  </label>
                  <label className="kb-pill-select">
                    <span className="lbl">model</span>
                    <ModelPicker
                      value={modelSelection}
                      onChange={setModelSelection}
                      className="kb-pill-select-native mono"
                      agentRunsOnly
                    />
                    <span className="caret">▾</span>
                  </label>
                  <label className="kb-pill-select">
                    <span className="lbl">effort</span>
                    <select
                      value={effort}
                      onChange={(e) => setEffort(e.target.value as Effort)}
                      className="kb-pill-select-native mono"
                    >
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                      <option value="max">max</option>
                    </select>
                    <span className="caret">▾</span>
                  </label>
                </div>
              </div>

              {/* CHECKS */}
              <div className="kb-field">
                <label className="kb-field-label">
                  Auto-run on each step
                  <span className="kb-field-hint">surface failures inline on the card</span>
                </label>
                <div className="kb-checklist">
                  {(
                    [
                      ['tsc', 'Typecheck', 'pnpm typecheck · ~4s'],
                      ['tests', 'Unit tests', 'vitest · ~12s'],
                      ['lint', 'Lint', 'eslint --cache · ~2s'],
                      ['e2e', 'End-to-end', 'playwright · only on review-ready'],
                      ['preview', 'Branch preview', 'live URL on the card'],
                    ] as const
                  ).map(([k, name, sub]) => (
                    <label key={k}>
                      <input
                        type="checkbox"
                        checked={checks[k]}
                        onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })}
                      />
                      <div>
                        <b style={{ fontWeight: 500, color: 'var(--ink)' }}>{name}</b>
                        <span className="lt">{sub}</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* LABELS */}
              <div className="kb-field" style={{ marginBottom: 0 }}>
                <label className="kb-field-label">Labels</label>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: 'var(--ink-3)',
                        marginBottom: 5,
                      }}
                    >
                      TYPE
                    </div>
                    <div className="kb-seg">
                      {(['feat', 'fix', 'chore', 'infra', 'docs'] as Tag[]).map((t) => (
                        <button
                          key={t}
                          type="button"
                          className={tag === t ? 'on' : ''}
                          onClick={() => setTag(t)}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: 'var(--ink-3)',
                        marginBottom: 5,
                      }}
                    >
                      PRIORITY
                    </div>
                    <div className="kb-seg">
                      {(['p0', 'p1', 'p2', 'p3'] as Priority[]).map((p) => (
                        <button
                          key={p}
                          type="button"
                          className={priority === p ? 'on' : ''}
                          onClick={() => setPriority(p)}
                        >
                          {p.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </form>
          </main>

          <aside className="kb-modal-aside">
            <div className="kb-mas-block">
              <div className="kb-mas-h">How it'll appear</div>
              <div
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'var(--ink-3)',
                  marginBottom: 8,
                }}
              >
                {mode === 'queue'
                  ? 'BACKLOG'
                  : mode === 'spec'
                    ? 'AWAITING INPUT'
                    : 'IN PROGRESS'}
              </div>
              <div className="kb-preview-card-wrap">
                <CardPreview issue={previewIssue} />
              </div>
              <div
                style={{
                  marginTop: 12,
                  fontSize: 11,
                  color: 'var(--ink-3)',
                  lineHeight: 1.55,
                }}
              >
                Branch{' '}
                <span style={{ fontFamily: 'var(--ff-mono)', color: 'var(--accent)' }}>
                  {branchName}
                </span>{' '}
                off <span style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ink-1)' }}>main</span>{' '}
                in{' '}
                <span style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ink-2)' }}>
                  .kanbots/worktrees/issue-N
                </span>
              </div>
            </div>
          </aside>
        </div>

        <div className="kb-modal-foot">
          <span className="hint">{modeDef.hint}</span>
          {error ? (
            <span style={{ color: 'var(--failed)', fontSize: 11.5 }} role="alert">
              {error}
            </span>
          ) : null}
          <span className="grow" />
          <button type="button" className="kb-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <SplitButton
            primaryLabel={submitting ? 'Creating…' : modeDef.submitLabel}
            primaryDisabled={submitting || pasting > 0 || !title.trim()}
            onPrimary={() => void submit()}
            options={[
              {
                label: 'Save as draft (Backlog)',
                onPick: () => void submitAsDraft(),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function SplitButton({
  primaryLabel,
  primaryDisabled,
  onPrimary,
  options,
}: {
  primaryLabel: string;
  primaryDisabled: boolean;
  onPrimary: () => void;
  options: Array<{ label: string; onPick: () => void }>;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.kb-btn-grp')) return;
      setOpen(false);
    }
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="kb-btn-grp" style={{ position: 'relative' }}>
      <button
        type="button"
        className="kb-btn primary"
        onClick={onPrimary}
        disabled={primaryDisabled}
      >
        {primaryLabel}
        <span className="kb-kbd" style={{ marginLeft: 6 }}>
          ⌘↵
        </span>
      </button>
      <button
        type="button"
        className="kb-btn primary"
        onClick={() => setOpen((v) => !v)}
        aria-label="More options"
        title="More options"
      >
        ▾
      </button>
      {open ? (
        <div
          className="kb-btn-grp-menu"
          style={{ bottom: 'calc(100% + 6px)', right: 0 }}
        >
          {options.map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => {
                setOpen(false);
                opt.onPick();
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

