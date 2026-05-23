import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { getBridge } from '../../desktop-bridge.js';
import { useFetch } from '../../hooks/useFetch.js';
import { useIssues } from '../../hooks/useIssues.js';
import { useWorkspace } from '../../hooks/useWorkspace.js';
import { ageString, colorForLogin } from '../../labels.js';
import type { ChatConversation, Issue } from '../../types.js';
import { CollapsibleSection } from './CollapsibleSection.js';
import { WorkspaceTree } from './WorkspaceTree.js';
import { WorktreesSection } from './WorktreesSection.js';

export interface LeftRailProps {
  selectedNumber: number | null;
  onSelectIssue: (n: number) => void;
  onOpenPalette?: () => void;
  authorLogin?: string | null;
  onOpenArchive?: () => void;
  onOpenStats?: () => void;
  onOpenProviders?: () => void;
  onOpenCloud?: () => void;
  onOpenRules?: () => void;
  onOpenScripts?: () => void;
  onOpenSentry?: () => void;
}


function LiveAgentRow({
  issue,
  selected,
  onClick,
}: {
  issue: Issue;
  selected: boolean;
  onClick: () => void;
}) {
  const stateCls =
    issue.agent === 'blocked'
      ? 'kb-state-awaiting'
      : issue.agent === 'review'
        ? 'kb-state-review'
        : '';
  const tool = issue.activeRun?.currentTool ?? null;
  const arg = issue.activeRun?.currentArg ?? null;
  const argTail = arg ? arg.split('/').pop() ?? arg : '';
  return (
    <button
      type="button"
      className="kb-swarm-card"
      onClick={onClick}
      aria-pressed={selected}
      title={issue.title}
    >
      <span className={`kb-swarm-bar ${stateCls}`} aria-hidden />
      <span className="kb-swarm-meta">
        <div className="kb-swarm-num">
          #{issue.number}
          {issue.activeRun ? ` · run ${issue.activeRun.id}` : ''}
        </div>
        <div className="kb-swarm-title">{issue.title}</div>
        <div className="kb-swarm-tool">
          {issue.agent === 'blocked'
            ? 'awaiting input'
            : tool
              ? `${tool}${argTail ? ` · ${argTail.slice(0, 28)}` : ''}`
              : 'starting…'}
        </div>
      </span>
    </button>
  );
}

function ChatList() {
  const bridge = getBridge();
  const { data: chats, loading, refetch } = useFetch<ChatConversation[]>(
    bridge ? 'chats' : null,
    () => api.listChats(),
  );
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);

  // Poll while mounted so auto-derived titles, renames, and newly created
  // chats from other windows surface here without requiring the user to
  // re-open the rail. Also refetch on focus — covers the common pattern of
  // switching back from the chat window to the board.
  useEffect(() => {
    if (!bridge) return;
    const interval = window.setInterval(() => {
      void refetch();
    }, 10_000);
    const onFocus = (): void => {
      void refetch();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [bridge, refetch]);

  const filtered = useMemo(() => {
    const list = chats ?? [];
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return list;
    return list.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, filter]);

  const visible = expanded ? filtered : filtered.slice(0, 6);

  if (!bridge) return null;

  return (
    <CollapsibleSection
      storageKey="chats"
      className="kb-rail-chats"
      label="Chats"
      trailing={
        <button
          type="button"
          className="kb-rail-chats-new"
          title="Start a new chat"
          aria-label="Start a new chat"
          onClick={(e) => {
            // Don't let the click bubble up and toggle the section.
            e.stopPropagation();
            void bridge.openChat?.(null);
          }}
        >
          +
        </button>
      }
    >
      <input
        type="search"
        className="kb-rail-chats-search"
        placeholder="Search chats…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="kb-rail-chats-list">
        {loading && (chats === null || chats.length === 0) ? (
          <div className="kb-rail-chats-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="kb-rail-chats-empty">
            {filter ? 'No matches' : 'No chats yet'}
          </div>
        ) : (
          visible.map((c) => (
            <button
              key={c.id}
              type="button"
              className="kb-rail-chat-row"
              title={c.title}
              onClick={() => {
                void bridge.openChat?.(c.id);
                void refetch();
              }}
            >
              <div className="kb-rail-chat-title">{c.title}</div>
              <div className="kb-rail-chat-time">
                {ageString(c.lastMessageAt)} ago
              </div>
            </button>
          ))
        )}
        {!expanded && filtered.length > visible.length ? (
          <button
            type="button"
            className="kb-rail-chats-more"
            onClick={() => setExpanded(true)}
          >
            Show {filtered.length - visible.length} more
          </button>
        ) : null}
        {expanded && filtered.length > 6 ? (
          <button
            type="button"
            className="kb-rail-chats-more"
            onClick={() => setExpanded(false)}
          >
            Show less
          </button>
        ) : null}
      </div>
    </CollapsibleSection>
  );
}

export function LeftRail({
  selectedNumber,
  onSelectIssue,
  onOpenPalette,
  authorLogin,
  onOpenArchive,
  onOpenStats,
  onOpenProviders,
  onOpenCloud,
  onOpenRules,
  onOpenScripts,
  onOpenSentry,
}: LeftRailProps) {
  const ws = useWorkspace();
  const { issues } = useIssues();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function onPointerDown(e: PointerEvent): void {
      if (!accountMenuRef.current) return;
      if (e.target instanceof Node && accountMenuRef.current.contains(e.target)) return;
      setAccountMenuOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setAccountMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [accountMenuOpen]);

  function pick(handler: (() => void) | undefined): void {
    setAccountMenuOpen(false);
    handler?.();
  }

  const liveAgents = issues.filter(
    (i) =>
      i.agent === 'running' || i.agent === 'blocked' || i.agent === 'review',
  );
  const runs = liveAgents.filter((i) => i.agent === 'running').length;

  const me: string = authorLogin ?? 'you';
  const meColor = colorForLogin(me);

  const currentFolder =
    ws.folders.find((f) => f.current) ?? ws.folders[0] ?? null;

  const headerName = currentFolder?.name ?? ws.workspace.name ?? 'Workspace';
  const headerSubtitle = currentFolder?.branch ?? null;

  return (
    <div className="kb-rail">
      <CollapsibleSection
        storageKey="workspace"
        className="kb-rail-tree-section"
        label="Workspace"
        trailing={
          ws.workspace.activeAgents > 0 ? (
            <span className="kb-rail-label-pulse" aria-label={`${ws.workspace.activeAgents} active agents`}>
              <span className="kb-pulse" />
              {ws.workspace.activeAgents}
            </span>
          ) : null
        }
      >
        <WorkspaceTree
          header={{ name: headerName, ...(headerSubtitle ? { subtitle: headerSubtitle } : {}) }}
          onSelectIssue={onSelectIssue}
        />
      </CollapsibleSection>

      <WorktreesSection />

      {liveAgents.length > 0 ? (
        <CollapsibleSection
          storageKey="live-agents"
          label="Live agents"
          trailing={
            <span className="kb-rail-label-count" aria-label={`${liveAgents.length} live`}>
              {liveAgents.length}
            </span>
          }
        >
          {liveAgents.map((issue) => (
            <LiveAgentRow
              key={issue.number}
              issue={issue}
              selected={selectedNumber === issue.number}
              onClick={() => onSelectIssue(issue.number)}
            />
          ))}
        </CollapsibleSection>
      ) : null}

      <ChatList />

      <div className="kb-rail-foot" ref={accountMenuRef}>
        <button
          type="button"
          className="kb-rail-account"
          onClick={() => setAccountMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          title="Workspace menu"
        >
          <span className="kb-rail-avatar" style={{ background: meColor }} aria-hidden>
            {String(me).slice(0, 1).toUpperCase()}
          </span>
          <span className="kb-who">
            <span className="kb-who-name">{String(me)}</span>
            <span className="kb-who-status">
              <span className="kb-pulse" />
              {runs} run{runs === 1 ? '' : 's'} · {issues.length} issue{issues.length === 1 ? '' : 's'}
            </span>
          </span>
          <span className="kb-rail-account-caret" aria-hidden>
            ⌃
          </span>
        </button>
        <button
          type="button"
          className="kb-rail-cmdk"
          onClick={onOpenPalette}
          title="Command palette (⌘K)"
        >
          ⌘K
        </button>

        {accountMenuOpen ? (
          <div className="kb-rail-account-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="kb-rail-account-item"
              onClick={() => pick(onOpenArchive)}
            >
              <span className="kb-rail-account-icon" aria-hidden>📦</span>
              Archive
            </button>
            <button
              type="button"
              role="menuitem"
              className="kb-rail-account-item"
              onClick={() => pick(onOpenStats)}
            >
              <span className="kb-rail-account-icon" aria-hidden>📊</span>
              Stats &amp; cost
            </button>
            <div className="kb-rail-account-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="kb-rail-account-item"
              onClick={() => pick(onOpenProviders)}
            >
              <span className="kb-rail-account-icon" aria-hidden>⚡</span>
              Providers
            </button>
            <button
              type="button"
              role="menuitem"
              className="kb-rail-account-item"
              onClick={() => pick(onOpenCloud)}
            >
              <span className="kb-rail-account-icon" aria-hidden>☁</span>
              Cloud
            </button>
            <button
              type="button"
              role="menuitem"
              className="kb-rail-account-item"
              onClick={() => pick(onOpenRules)}
            >
              <span className="kb-rail-account-icon" aria-hidden>📜</span>
              House rules
            </button>
            <button
              type="button"
              role="menuitem"
              className="kb-rail-account-item"
              onClick={() => pick(onOpenScripts)}
            >
              <span className="kb-rail-account-icon" aria-hidden>▸_</span>
              Repo scripts
            </button>
            <div className="kb-rail-account-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="kb-rail-account-item"
              onClick={() => pick(onOpenSentry)}
            >
              <span className="kb-rail-account-icon" aria-hidden>⚙</span>
              Settings
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
