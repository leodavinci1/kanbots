import { useEffect, useState } from 'react';
import type { AgentRunEventPayload } from '../global.js';
import type { AgentEvent, AgentRunStatus, Card } from '../types.js';

export interface AgentRunStreamState {
  events: AgentEvent[];
  cards: Card[];
  status: AgentRunStatus | null;
  error: string | null;
}

export type AgentRunStreamScope = 'workspace' | 'chat';

const EMPTY_STATE: AgentRunStreamState = {
  events: [],
  cards: [],
  status: null,
  error: null,
};

/**
 * @param runId run to subscribe to (null disables)
 * @param resubscribeKey bump to force a fresh subscription even if `runId`
 *   stays the same. Needed for chat conversations where a single run id
 *   resumes after a terminal status — the server-side subscription closes
 *   on terminal status, so without re-subscribing the renderer would miss
 *   the events of the resumed run.
 */
export function useAgentRunStream(
  runId: number | null,
  resubscribeKey: number = 0,
  scope: AgentRunStreamScope = 'workspace',
): AgentRunStreamState {
  const [state, setState] = useState<AgentRunStreamState>(EMPTY_STATE);

  useEffect(() => {
    if (runId === null) {
      setState(EMPTY_STATE);
      return;
    }

    setState(EMPTY_STATE);

    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) {
      setState({
        ...EMPTY_STATE,
        error: 'window.kanbots not available — renderer must run inside Electron',
      });
      return;
    }

    let cancelled = false;
    let subscriptionId: string | null = null;
    let unsubscribeBridge: (() => void) | null = null;

    bridge
      .invoke('agent-runs:events:subscribe', { runId, scope })
      .then(({ subscriptionId: subId, runStatus }) => {
        if (cancelled) {
          void bridge.invoke('agent-runs:events:unsubscribe', { subscriptionId: subId });
          return;
        }
        subscriptionId = subId;
        setState((prev) => ({ ...prev, status: runStatus }));
        unsubscribeBridge = bridge.subscribe('agent-runs:events:data', (raw) => {
          const payload = raw as AgentRunEventPayload;
          if (payload.subscriptionId !== subId) return;
          if (payload.kind === 'event') {
            const ev = payload.event;
            setState((prev) => {
              if (prev.events.some((existing) => existing.seq === ev.seq)) return prev;
              const next = [...prev.events, ev].sort((a, b) => a.seq - b.seq);
              return { ...prev, events: next };
            });
          } else if (payload.kind === 'card') {
            const card = payload.card;
            setState((prev) => {
              const exists = prev.cards.some((c) => c.id === card.id);
              return exists
                ? {
                    ...prev,
                    cards: prev.cards.map((c) => (c.id === card.id ? card : c)),
                  }
                : { ...prev, cards: [...prev.cards, card] };
            });
          } else if (payload.kind === 'status') {
            const status = payload.status;
            setState((prev) => ({ ...prev, status }));
          }
          // 'end' → main process auto-cleans the subscription; nothing to do.
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }));
      });

    return () => {
      cancelled = true;
      if (unsubscribeBridge) unsubscribeBridge();
      if (subscriptionId !== null) {
        void bridge.invoke('agent-runs:events:unsubscribe', { subscriptionId });
      }
    };
  }, [runId, resubscribeKey, scope]);

  return state;
}
