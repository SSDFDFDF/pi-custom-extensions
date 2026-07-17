/**
 * Minimal channel-agnostic queue (phase 0/1).
 * Semantics intentionally aligned with proven lane ideas from pi-telegram,
 * without Telegram types.
 */

import type {
  ChannelTurn,
  QueueLane,
  TurnId,
} from "./types.ts";

const LANE_RANK: Record<QueueLane, number> = {
  control: 0,
  priority: 1,
  default: 2,
};

export interface ChannelQueueState {
  items: ChannelTurn[];
  active?: ChannelTurn;
  pendingDispatch: boolean;
}

export function createChannelQueueState(): ChannelQueueState {
  return { items: [], active: undefined, pendingDispatch: false };
}

export function compareChannelTurns(a: ChannelTurn, b: ChannelTurn): number {
  const laneDelta = LANE_RANK[a.lane] - LANE_RANK[b.lane];
  if (laneDelta !== 0) return laneDelta;
  return a.createdAt - b.createdAt;
}

export function enqueueTurn(
  state: ChannelQueueState,
  turn: ChannelTurn,
): ChannelQueueState {
  const items = [...state.items, turn].sort(compareChannelTurns);
  return { ...state, items };
}

export function peekNextTurn(
  state: ChannelQueueState,
): ChannelTurn | undefined {
  return state.items[0];
}

export function beginDispatch(
  state: ChannelQueueState,
): { state: ChannelQueueState; turn?: ChannelTurn } {
  if (state.active || state.pendingDispatch) {
    return { state };
  }
  const [turn, ...rest] = state.items;
  if (!turn) return { state };
  return {
    state: {
      items: rest,
      active: turn,
      pendingDispatch: true,
    },
    turn,
  };
}

/** agent_start consumed the turn */
export function markTurnRunning(state: ChannelQueueState): ChannelQueueState {
  return { ...state, pendingDispatch: false };
}

export function clearActiveTurn(state: ChannelQueueState): ChannelQueueState {
  return { ...state, active: undefined, pendingDispatch: false };
}

export function abortKeepQueue(state: ChannelQueueState): ChannelQueueState {
  return { ...state, active: undefined, pendingDispatch: false };
}

export function stopClearQueue(state: ChannelQueueState): ChannelQueueState {
  return { items: [], active: undefined, pendingDispatch: false };
}

export function removeTurn(
  state: ChannelQueueState,
  turnId: TurnId,
): ChannelQueueState {
  return {
    ...state,
    items: state.items.filter((item) => item.turnId !== turnId),
    active: state.active?.turnId === turnId ? undefined : state.active,
  };
}

export function queueLength(state: ChannelQueueState): number {
  return state.items.length + (state.active ? 1 : 0);
}
