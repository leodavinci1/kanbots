import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useIssues } from '../../hooks/useIssues.js';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  category: 'quick' | 'jump' | 'agent' | 'ask';
  serif?: boolean;
  onPick: () => void;
}

export interface PaletteProps {
  open: boolean;
  selectedNumber: number | null;
  onClose: () => void;
  onJump: (n: number) => void;
  onOpenCreate: (initialDescription?: string) => void;
  onOpenDetail: (n: number) => void;
  onOpenSplit?: (n: number) => void;
  onSpawnAgentSelected?: () => void;
  onResolveTopDecision?: () => void;
}

function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return 100 - (t.indexOf(q) || 0) / 100;
  // poor man's subsequence match
  let qi = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++;
      score += 1;
    }
  }
  return qi === q.length ? score / 2 : 0;
}

const searchIcon = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export function Palette({
  open,
  selectedNumber,
  onClose,
  onJump,
  onOpenCreate,
  onOpenDetail,
  onOpenSplit,
  onSpawnAgentSelected,
  onResolveTopDecision,
}: PaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { issues } = useIssues();

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Defer to next paint for autofocus.
      const handle = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(handle);
    }
    return undefined;
  }, [open]);

  const quickActions: PaletteAction[] = useMemo(
    () => [
      {
        id: 'new-task',
        label: 'New task',
        hint: 'N',
        category: 'quick',
        onPick: () => {
          onClose();
          onOpenCreate();
        },
      },
      ...(selectedNumber !== null
        ? [
            {
              id: 'open-detail',
              label: `Open #${selectedNumber} in detail`,
              hint: 'Enter',
              category: 'quick' as const,
              onPick: () => {
                onClose();
                onOpenDetail(selectedNumber);
              },
            },
            {
              id: 'spawn-agent',
              label: `Spawn agent on #${selectedNumber}`,
              hint: '⇧⏎',
              category: 'agent' as const,
              onPick: () => {
                onClose();
                onSpawnAgentSelected?.();
              },
            },
          ]
        : []),
      ...(selectedNumber !== null && onOpenSplit
        ? [
            {
              id: 'split-task',
              label: `Split #${selectedNumber} into sub-tasks…`,
              hint: '⌘⇧S',
              category: 'agent' as const,
              onPick: () => {
                onClose();
                onOpenSplit(selectedNumber);
              },
            },
          ]
        : []),
      {
        id: 'resolve-decision',
        label: 'Resolve top decision',
        hint: 'D',
        category: 'agent',
        onPick: () => {
          onClose();
          onResolveTopDecision?.();
        },
      },
      {
        id: 'open-repo-scripts',
        label: 'Open Repo scripts settings',
        category: 'quick',
        onPick: () => {
          onClose();
          window.dispatchEvent(new CustomEvent('kanbots:open-repo-scripts'));
        },
      },
      {
        id: 'run-setup-script',
        label: 'Run setup script',
        category: 'quick',
        onPick: () => {
          onClose();
          window.dispatchEvent(
            new CustomEvent('kanbots:open-repo-scripts', { detail: { autoRun: 'setup' } }),
          );
        },
      },
      {
        id: 'run-cleanup-script',
        label: 'Run cleanup script',
        category: 'quick',
        onPick: () => {
          onClose();
          window.dispatchEvent(
            new CustomEvent('kanbots:open-repo-scripts', { detail: { autoRun: 'cleanup' } }),
          );
        },
      },
    ],
    [
      selectedNumber,
      onClose,
      onOpenCreate,
      onOpenDetail,
      onOpenSplit,
      onSpawnAgentSelected,
      onResolveTopDecision,
    ],
  );

  const jumpActions: PaletteAction[] = useMemo(() => {
    const trimmed = query.trim();
    const issueMatch = /^#?(\d+)$/.exec(trimmed);
    if (issueMatch?.[1]) {
      const n = Number.parseInt(issueMatch[1], 10);
      const exact = issues.find((i) => i.number === n);
      if (exact) {
        return [
          {
            id: `jump:${n}`,
            label: `#${n} ${exact.title}`,
            hint: exact.status ?? 'inbox',
            category: 'jump',
            onPick: () => {
              onClose();
              onJump(n);
            },
          },
        ];
      }
    }
    return issues
      .map((issue) => ({
        issue,
        score: fuzzyScore(trimmed, `${issue.number} ${issue.title}`),
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ issue }) => ({
        id: `jump:${issue.number}`,
        label: `#${issue.number} ${issue.title}`,
        hint: issue.status ?? 'inbox',
        category: 'jump' as const,
        onPick: () => {
          onClose();
          onJump(issue.number);
        },
      }));
  }, [issues, query, onClose, onJump]);

  const askAction: PaletteAction | null = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed || /^#?\d+$/.test(trimmed)) return null;
    return {
      id: 'ask-claude',
      label: `“${trimmed}”`,
      hint: '⇧⏎',
      category: 'ask',
      serif: true,
      onPick: () => {
        onClose();
        onOpenCreate(trimmed);
      },
    };
  }, [query, onClose, onOpenCreate]);

  const sections: Array<{ title: string; actions: PaletteAction[] }> = useMemo(() => {
    const out: Array<{ title: string; actions: PaletteAction[] }> = [];
    const matches = (a: PaletteAction): boolean =>
      query.trim().length === 0 || fuzzyScore(query.trim(), a.label) > 0;
    const quick = quickActions.filter((a) => a.category === 'quick' && matches(a));
    const agent = quickActions.filter((a) => a.category === 'agent' && matches(a));
    if (quick.length > 0) out.push({ title: 'Quick actions', actions: quick });
    if (agent.length > 0) out.push({ title: 'Spawn agent', actions: agent });
    if (jumpActions.length > 0) out.push({ title: 'Jump to issue', actions: jumpActions });
    if (askAction) out.push({ title: 'Ask Claude', actions: [askAction] });
    return out;
  }, [quickActions, jumpActions, askAction, query]);

  const flat: PaletteAction[] = useMemo(
    () => sections.flatMap((s) => s.actions),
    [sections],
  );

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(flat.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const action = flat[activeIndex];
      if (action) action.onPick();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  return (
    <div className="kb-palette-overlay kb-app" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="kb-palette" onClick={(e) => e.stopPropagation()}>
        <div className="kb-palette-input">
          <span aria-hidden>{searchIcon}</span>
          <input
            ref={inputRef}
            type="text"
            placeholder="Run a command, jump to issue, ask an agent…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKey}
            aria-label="Command palette input"
          />
          <span className="kbd-hint">esc</span>
        </div>
        <div className="kb-palette-body">
          {flat.length === 0 ? (
            <div className="kb-palette-empty">No matches.</div>
          ) : (
            sections.map((section) => (
              <div key={section.title} className="kb-palette-section">
                <div className="kb-palette-section-h">{section.title}</div>
                {section.actions.map((action) => {
                  const isActive = flat.indexOf(action) === activeIndex;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      className={`kb-palette-row${isActive ? ' active' : ''}`}
                      onMouseEnter={() => setActiveIndex(flat.indexOf(action))}
                      onClick={action.onPick}
                    >
                      {action.category === 'jump' ? (
                        <span className="num">{action.label.split(' ')[0]}</span>
                      ) : (
                        <span className="ico" aria-hidden>
                          {section.title === 'Ask Claude' ? '✶' : '›'}
                        </span>
                      )}
                      <span className={`label${action.serif ? ' serif' : ''}`}>
                        {action.category === 'jump'
                          ? action.label.split(' ').slice(1).join(' ')
                          : action.label}
                      </span>
                      {action.hint ? <span className="hint">{action.hint}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

