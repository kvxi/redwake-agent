import type { Provider } from "../config.ts";

export type Activity = "idle" | "thinking" | "responding" | "running";
export type NoticeTone = "info" | "success" | "warning" | "error";

export interface TuiIdentity {
  provider: Provider;
  model: string;
  cwd: string;
  sessionName: string;
  sessionNumber?: number;
  eventCount: number;
  reasoning?: string;
}

export type TranscriptBlock =
  | { id: number; revision: number; kind: "welcome" }
  | { id: number; revision: number; kind: "user"; text: string }
  | { id: number; revision: number; kind: "assistant"; text: string }
  | { id: number; revision: number; kind: "tool"; text: string; tone?: NoticeTone }
  | { id: number; revision: number; kind: "notice"; text: string; tone: NoticeTone };

export interface ListOverlayState {
  title: string;
  rows: readonly string[];
  selected: number;
  offset: number;
  footer: string;
}

export interface TuiState {
  identity: TuiIdentity;
  activity: { kind: Activity; label?: string };
  transcript: readonly TranscriptBlock[];
  input: { active: boolean; label: string; value: string; cursor: number };
  overlay?: ListOverlayState;
  scrollOffset: number;
  followOutput: boolean;
  columns: number;
  rows: number;
}

export function createTuiState(identity: TuiIdentity, columns = 80, rows = 24): TuiState {
  return {
    identity: { ...identity },
    activity: { kind: "idle" },
    transcript: [{ id: 0, revision: 0, kind: "welcome" }],
    input: { active: false, label: ">", value: "", cursor: 0 },
    scrollOffset: 0,
    followOutput: true,
    columns: Math.max(1, columns),
    rows: Math.max(3, rows),
  };
}

export function resizeState(state: TuiState, columns: number, rows: number): TuiState {
  return { ...state, columns: Math.max(1, columns), rows: Math.max(3, rows) };
}

export function updateIdentity(state: TuiState, patch: Partial<TuiIdentity>): TuiState {
  return { ...state, identity: { ...state.identity, ...patch } };
}

export function updateActivity(state: TuiState, kind: Activity, label?: string): TuiState {
  return { ...state, activity: label ? { kind, label } : { kind } };
}
