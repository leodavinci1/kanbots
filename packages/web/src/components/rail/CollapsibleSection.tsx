import { useEffect, useState, type ReactNode } from 'react';

/**
 * A LeftRail section whose body can be collapsed via a clickable header.
 * State persists across reloads under `kb-rail-collapsed:<key>` in
 * localStorage so the rail remembers which sections the user prefers
 * to keep tucked away.
 */

const STORAGE_PREFIX = 'kb-rail-collapsed:';

function readStored(key: string, defaultCollapsed: boolean): boolean {
  if (typeof window === 'undefined') return defaultCollapsed;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // localStorage can throw in private mode — fall through to default
  }
  return defaultCollapsed;
}

function writeStored(key: string, collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, collapsed ? '1' : '0');
  } catch {
    // ignore quota / private-mode errors
  }
}

export function useCollapsibleSection(
  key: string,
  defaultCollapsed = false,
): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readStored(key, defaultCollapsed));
  useEffect(() => {
    writeStored(key, collapsed);
  }, [key, collapsed]);
  return [collapsed, () => setCollapsed((v) => !v)];
}

export interface CollapsibleSectionProps {
  /** Stable storage key — keep across releases so users keep their state. */
  storageKey: string;
  label: ReactNode;
  /** Optional badge/count rendered right of the label, before the caret. */
  trailing?: ReactNode;
  /** Defaults to false (section starts expanded). */
  defaultCollapsed?: boolean;
  /** Extra class for the wrapper. */
  className?: string;
  children: ReactNode;
}

export function CollapsibleSection({
  storageKey,
  label,
  trailing,
  defaultCollapsed = false,
  className,
  children,
}: CollapsibleSectionProps) {
  const [collapsed, toggle] = useCollapsibleSection(storageKey, defaultCollapsed);
  return (
    <div
      className={`kb-rail-section kb-rail-collapsible${collapsed ? ' is-collapsed' : ''}${className ? ` ${className}` : ''}`}
    >
      <div className="kb-rail-label-row">
        <button
          type="button"
          className="kb-rail-label kb-rail-label-button"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          <span className="kb-rail-label-caret" aria-hidden>
            {collapsed ? '▸' : '▾'}
          </span>
          <span className="kb-rail-label-text">{label}</span>
        </button>
        {trailing ? <span className="kb-rail-label-trailing">{trailing}</span> : null}
      </div>
      {collapsed ? null : <div className="kb-rail-section-body">{children}</div>}
    </div>
  );
}
