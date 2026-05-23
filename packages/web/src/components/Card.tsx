import { useDraggable } from '@dnd-kit/core';
import { memo, useEffect, useState, type ChangeEvent, type MouseEvent } from 'react';
import { api } from '../api.js';
import { dispatchIssuesRefetch } from '../hooks/useIssues.js';
import {
  ageString,
  areaLabels,
  colorForLogin,
  priorityFromLabels,
  strippedBranch,
  tagFromLabels,
} from '../labels.js';
import type { Issue, IssueActiveRun, ShipStatus } from '../types.js';

export function cardDragId(issueNumber: number): string {
  return `card:${issueNumber}`;
}

export interface CardProps {
  issue: Issue;
  selected?: boolean;
  draggable?: boolean;
  liveTool?: { name: string; arg: string | null } | null;
  onSelect?: (issueNumber: number) => void;
  onOpen?: (issueNumber: number) => void;
}

const branchIcon = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M6 7v10M8 12h8" />
  </svg>
);

function statusPillFor(issue: Issue): { label: string; cls: string } | null {
  switch (issue.agent) {
    case 'running':
      return { label: 'RUNNING', cls: 'kb-state-running' };
    case 'blocked':
      return { label: 'WAITING ON YOU', cls: 'kb-state-awaiting' };
    case 'review':
      return { label: 'READY TO REVIEW', cls: 'kb-state-review' };
    case 'queued':
      return { label: 'QUEUED', cls: 'kb-state-queued' };
    case 'failed':
      return { label: 'FAILED', cls: 'kb-state-failed' };
    default:
      return null;
  }
}

function stateClassFor(issue: Issue): string {
  switch (issue.agent) {
    case 'running':
      return 'kb-state-running';
    case 'blocked':
      return 'kb-state-awaiting';
    case 'review':
      return 'kb-state-review';
    default:
      return '';
  }
}

function CardBody({
  issue,
  liveTool,
  onReviewAction,
}: {
  issue: Issue;
  liveTool: CardProps['liveTool'];
  onReviewAction?: () => void;
}) {
  const tag = tagFromLabels(issue.labels, issue.isPullRequest);
  const priority = priorityFromLabels(issue.labels);
  const pill = statusPillFor(issue);
  const active: IssueActiveRun | null = issue.activeRun ?? null;
  const branch = strippedBranch(active?.branch);
  const isRunning = issue.agent === 'running';
  const isBlocked = issue.agent === 'blocked';
  const isReview = issue.agent === 'review';
  const tickerName = liveTool?.name ?? active?.currentTool ?? null;
  const tickerArg = liveTool?.arg ?? active?.currentArg ?? null;
  const decision = active?.pendingDecision ?? null;
  const checks = active?.checks ?? null;
  const stats =
    active &&
    typeof active.additions === 'number' &&
    typeof active.deletions === 'number'
      ? { add: active.additions, del: active.deletions }
      : null;
  const progress = active?.progress ?? null;
  const areas = areaLabels(issue.labels);

  return (
    <>
      <div className="kb-card-row1">
        {tag ? <span className={`kb-tag kb-tag-${tag}`}>{tag}</span> : null}
        <span className="kb-card-num">#{issue.number}</span>
        {priority ? (
          <span className={`kb-card-pri kb-pri-${priority}`}>{priority.toUpperCase()}</span>
        ) : null}
        {issue.sentryMeta ? (
          <span
            className={`kb-sentry-badge kb-sentry-${issue.sentryMeta.status}`}
            title={`Sentry · ${issue.sentryMeta.count} occurrence${issue.sentryMeta.count === 1 ? '' : 's'}`}
          >
            SENTRY{issue.sentryMeta.status === 'analyzed' ? ' · REVIEWED' : ''}
          </span>
        ) : null}
        {pill ? (
          <span className={`kb-status-pill ${pill.cls}`}>
            <span className="kb-pulse" />
            {pill.label}
          </span>
        ) : null}
      </div>
      <div className="kb-card-title">{issue.title}</div>

      {isRunning && tickerName ? (
        <div className="kb-live-ticker" aria-label="Agent is running">
          <span className="kb-pulse-dot" />
          <span className="kb-tool">{tickerName}</span>
          {tickerArg ? <span className="kb-arg">{tickerArg}</span> : null}
        </div>
      ) : null}

      {isBlocked && decision ? (
        <>
          <div className="kb-card-decision" aria-label="Agent question">
            <div className="kb-q-icon" aria-hidden>
              ?
            </div>
            <div className="kb-q-text">{decision.question}</div>
          </div>
          <DecisionActions cardId={decision.cardId} options={decision.options} />
        </>
      ) : null}

      {(isRunning || isReview) && progress !== null ? (
        <div className="kb-card-progress" aria-label={`Progress ${Math.round(progress * 100)}%`}>
          <div className="kb-bar">
            <i style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
          </div>
          <span className="kb-pct">{Math.round(progress * 100)}%</span>
        </div>
      ) : null}

      {isReview ? (
        <ReviewActions
          issueNumber={issue.number}
          {...(onReviewAction ? { onAction: onReviewAction } : {})}
        />
      ) : null}

      <div className="kb-card-meta">
        {branch ? (
          <span className="kb-branch-pill" title={active?.branch ?? ''}>
            {branchIcon}
            {branch}
          </span>
        ) : null}
        {stats ? (
          <span className="kb-stats">
            <span className="add">+{stats.add}</span>
            <span className="del">−{stats.del}</span>
          </span>
        ) : null}
        {areas.length > 0 && !branch && !stats ? (
          <span className="kb-branch-pill">{areas[0]}</span>
        ) : null}
        {checks ? (
          <span className="kb-checks" aria-label="Checks">
            <CheckPill kind={checks.tests} label="tests" />
            <CheckPill kind={checks.typecheck} label="tsc" />
            <CheckPill kind={checks.lint} label="lint" />
          </span>
        ) : (
          <span className="kb-spacer" />
        )}
        <span className="kb-assignees">
          {issue.assignees.slice(0, 3).map((login) => (
            <span
              key={login}
              className="kb-av"
              style={{ background: colorForLogin(login) }}
              title={login}
            >
              {login.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
        <span className="kb-card-age">{ageString(issue.updatedAt || issue.createdAt)}</span>
      </div>
    </>
  );
}

function ReviewActions({
  issueNumber,
  onAction,
}: {
  issueNumber: number;
  onAction?: () => void;
}) {
  const [shipOpen, setShipOpen] = useState(false);
  function stop(e: MouseEvent<HTMLDivElement>): void {
    e.stopPropagation();
  }
  function toggleShip(e: MouseEvent<HTMLButtonElement>): void {
    e.stopPropagation();
    setShipOpen((v) => !v);
  }
  function requestChanges(e: MouseEvent<HTMLButtonElement>): void {
    e.stopPropagation();
    void api
      .requestChangesIssue(issueNumber)
      .then(() => {
        dispatchIssuesRefetch();
        onAction?.();
      });
  }
  function spawnReviewer(e: MouseEvent<HTMLButtonElement>): void {
    e.stopPropagation();
    void api
      .spawnReviewer(issueNumber)
      .then(() => {
        dispatchIssuesRefetch();
        onAction?.();
      });
  }
  function handleShipped(): void {
    setShipOpen(false);
    void api.approveIssue(issueNumber).then(() => {
      dispatchIssuesRefetch();
      onAction?.();
    });
  }
  return (
    <div className="kb-card-actions" onClick={stop}>
      <div className="kb-card-actions-row">
        <button type="button" className="kb-btn primary" onClick={toggleShip}>
          {shipOpen ? 'Cancel' : 'Ship…'}
        </button>
        <button type="button" className="kb-btn" onClick={requestChanges}>
          Request changes
        </button>
        <button type="button" className="kb-btn ghost" onClick={spawnReviewer}>
          Run reviewer
        </button>
      </div>
      {shipOpen ? (
        <ShipPanel
          issueNumber={issueNumber}
          onShipped={handleShipped}
          onCancel={() => setShipOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ShipPanel({
  issueNumber,
  onShipped,
  onCancel,
}: {
  issueNumber: number;
  onShipped: () => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<ShipStatus | null>(null);
  const [target, setTarget] = useState<string>('');
  const [busy, setBusy] = useState<null | 'merge' | 'pr'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .shipStatus(issueNumber)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setTarget(s.defaultMergeTarget);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [issueNumber]);

  async function ensureCommitted(): Promise<boolean> {
    if (!status?.hasUncommittedChanges) return true;
    const ok = window.confirm(
      'This worktree has uncommitted changes. Commit them automatically before shipping?',
    );
    if (!ok) return false;
    try {
      await api.shipCommit(issueNumber);
      const refreshed = await api.shipStatus(issueNumber);
      setStatus(refreshed);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function onMerge(e: MouseEvent<HTMLButtonElement>): Promise<void> {
    e.stopPropagation();
    if (!target) return;
    setBusy('merge');
    setError(null);
    if (!(await ensureCommitted())) {
      setBusy(null);
      return;
    }
    try {
      await api.shipMerge(issueNumber, target);
      onShipped();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onCreatePR(e: MouseEvent<HTMLButtonElement>): Promise<void> {
    e.stopPropagation();
    setBusy('pr');
    setError(null);
    if (!(await ensureCommitted())) {
      setBusy(null);
      return;
    }
    try {
      const result = await api.shipCreatePR({
        issueNumber,
        ...(target ? { targetBranch: target } : {}),
      });
      window.open(result.pr.htmlUrl, '_blank');
      onShipped();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function onChangeTarget(e: ChangeEvent<HTMLSelectElement>): void {
    setTarget(e.target.value);
  }

  if (status === null && error === null) {
    return (
      <div className="kb-ship-panel" aria-busy>
        Loading branch info…
      </div>
    );
  }

  return (
    <div className="kb-ship-panel">
      {status?.branchName ? (
        <div className="kb-ship-row">
          <span className="kb-ship-label">From</span>
          <code className="kb-ship-branch">{status.branchName}</code>
          {status.commitsAheadOfDefault > 0 ? (
            <span className="kb-ship-ahead">
              {status.commitsAheadOfDefault} commit
              {status.commitsAheadOfDefault === 1 ? '' : 's'} ahead
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="kb-ship-row">
        <label className="kb-ship-label" htmlFor={`ship-target-${issueNumber}`}>
          Target
        </label>
        <select
          id={`ship-target-${issueNumber}`}
          className="kb-input"
          value={target}
          onChange={onChangeTarget}
        >
          {(status?.availableTargets ?? []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
      {status?.hasUncommittedChanges ? (
        <div className="kb-ship-warn">
          Worktree has uncommitted changes — you&rsquo;ll be asked before
          shipping.
        </div>
      ) : null}
      {error !== null ? (
        <div className="kb-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="kb-ship-actions">
        <button
          type="button"
          className="kb-btn primary"
          disabled={busy !== null || !target}
          onClick={onMerge}
        >
          {busy === 'merge' ? 'Merging…' : 'Merge'}
        </button>
        <button
          type="button"
          className="kb-btn"
          disabled={busy !== null || !status?.branchName}
          onClick={onCreatePR}
        >
          {busy === 'pr' ? 'Opening PR…' : 'Open PR'}
        </button>
        <button type="button" className="kb-btn ghost" onClick={onCancel}>
          Close
        </button>
      </div>
    </div>
  );
}

const DECISION_RESOLVED_EVENT = 'kanbots:decision-resolved';

function DecisionActions({
  cardId,
  options,
}: {
  cardId: number;
  options: Array<{ value: string; label: string }>;
}) {
  const [submitting, setSubmitting] = useState(false);

  function stop(e: MouseEvent<HTMLDivElement>): void {
    e.stopPropagation();
  }

  async function pick(e: MouseEvent<HTMLButtonElement>, value: string): Promise<void> {
    e.stopPropagation();
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.resolveCard(cardId, value);
      window.dispatchEvent(new CustomEvent(DECISION_RESOLVED_EVENT));
      dispatchIssuesRefetch();
    } finally {
      setSubmitting(false);
    }
  }

  async function dismiss(e: MouseEvent<HTMLButtonElement>): Promise<void> {
    e.stopPropagation();
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.dismissCard(cardId);
      window.dispatchEvent(new CustomEvent(DECISION_RESOLVED_EVENT));
      dispatchIssuesRefetch();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="kb-card-actions" onClick={stop} role="group" aria-label="Decision options">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="kb-btn primary"
          disabled={submitting}
          onClick={(e) => void pick(e, opt.value)}
        >
          {submitting ? '…' : opt.label}
        </button>
      ))}
      <button
        type="button"
        className="kb-btn ghost"
        disabled={submitting}
        onClick={(e) => void dismiss(e)}
        title="Dismiss this decision and stop the run"
      >
        Dismiss
      </button>
    </div>
  );
}

function CheckPill({
  kind,
  label,
}: {
  kind: 'pass' | 'fail' | 'running' | 'idle';
  label: string;
}) {
  const cls =
    kind === 'pass' ? 'pass' : kind === 'fail' ? 'fail' : kind === 'running' ? 'run' : '';
  const icon = kind === 'pass' ? '✓' : kind === 'fail' ? '×' : kind === 'running' ? '↻' : '·';
  return (
    <span className={`kb-check ${cls}`} title={`${label}: ${kind}`} aria-label={`${label} ${kind}`}>
      {icon}
    </span>
  );
}

function CardImpl({
  issue,
  selected = false,
  draggable = true,
  liveTool = null,
  onSelect,
  onOpen,
}: CardProps) {
  const drag = useDraggable({
    id: cardDragId(issue.number),
    disabled: !draggable,
  });
  const stateCls = stateClassFor(issue);
  const setNodeRef = drag.setNodeRef;

  function handleClick(e: MouseEvent<HTMLButtonElement>): void {
    e.preventDefault();
    onSelect?.(issue.number);
  }
  function handleDoubleClick(e: MouseEvent<HTMLButtonElement>): void {
    e.preventDefault();
    onOpen?.(issue.number);
  }

  return (
    <button
      type="button"
      ref={setNodeRef}
      className={`kb-card ${stateCls}${selected ? ' kb-card-selected' : ''}${
        drag.isDragging ? ' kb-card-source' : ''
      }`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      {...(draggable ? drag.listeners : {})}
      {...(draggable ? drag.attributes : {})}
    >
      <CardBody issue={issue} liveTool={liveTool} />
    </button>
  );
}

export const Card = memo(CardImpl, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.draggable !== next.draggable) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.onOpen !== next.onOpen) return false;
  if (prev.liveTool?.name !== next.liveTool?.name) return false;
  if (prev.liveTool?.arg !== next.liveTool?.arg) return false;
  // Issue identity comparison: primitive fields that drive the visible card
  const a = prev.issue;
  const b = next.issue;
  if (a.number !== b.number) return false;
  if (a.title !== b.title) return false;
  if (a.updatedAt !== b.updatedAt) return false;
  if (a.agent !== b.agent) return false;
  if (a.status !== b.status) return false;
  if (a.labels.length !== b.labels.length) return false;
  if (a.assignees.length !== b.assignees.length) return false;
  // ActiveRun identity by id and core mutable fields. Include every field the
  // card body actually renders (branch, checks, decision, preview) so a late
  // backend update — e.g. branchName landing after status='starting' was first
  // visible — actually re-renders the card instead of being suppressed here.
  const ra = a.activeRun ?? null;
  const rb = b.activeRun ?? null;
  if (ra && rb) {
    if (
      ra.id !== rb.id ||
      ra.status !== rb.status ||
      ra.branch !== rb.branch ||
      ra.currentTool !== rb.currentTool ||
      ra.currentArg !== rb.currentArg ||
      ra.additions !== rb.additions ||
      ra.deletions !== rb.deletions ||
      ra.progress !== rb.progress ||
      ra.previewUrl !== rb.previewUrl ||
      ra.previewState !== rb.previewState ||
      (ra.pendingDecision?.cardId ?? null) !== (rb.pendingDecision?.cardId ?? null) ||
      ra.checks?.tests !== rb.checks?.tests ||
      ra.checks?.typecheck !== rb.checks?.typecheck ||
      ra.checks?.lint !== rb.checks?.lint
    ) {
      return false;
    }
  } else if (ra !== rb) {
    return false;
  }
  // Sentry meta — re-render when status changes (e.g. after analyze)
  const sa = a.sentryMeta ?? null;
  const sb = b.sentryMeta ?? null;
  if ((sa && sb) ? (sa.status !== sb.status || sa.count !== sb.count) : sa !== sb) return false;
  return true;
});

export function CardPreview({
  issue,
  liveTool = null,
}: {
  issue: Issue;
  liveTool?: CardProps['liveTool'];
}) {
  const stateCls = stateClassFor(issue);
  return (
    <div className={`kb-card kb-card-preview ${stateCls}`}>
      <CardBody issue={issue} liveTool={liveTool} />
    </div>
  );
}
