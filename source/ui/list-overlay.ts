export interface ListState<T> {
  items: readonly T[];
  selected: number;
  offset: number;
  rowCount: number;
}

export type ListKey = "up" | "down" | "page-up" | "page-down" | "enter" | "escape";
export interface ListResult<T> extends ListState<T> { outcome?: "confirm" | "cancel"; item?: T }

export function reduceList<T>(state: ListState<T>, key: ListKey): ListResult<T> {
  const count = state.items.length;
  const rows = Math.max(1, state.rowCount);
  let selected = count ? Math.min(count - 1, Math.max(0, state.selected)) : 0;
  if (key === "up") selected = Math.max(0, selected - 1);
  if (key === "down") selected = Math.min(Math.max(0, count - 1), selected + 1);
  if (key === "page-up") selected = Math.max(0, selected - rows);
  if (key === "page-down") selected = Math.min(Math.max(0, count - 1), selected + rows);
  let offset = Math.min(Math.max(0, state.offset), Math.max(0, count - rows));
  if (selected < offset) offset = selected;
  if (selected >= offset + rows) offset = selected - rows + 1;
  const result: ListResult<T> = { ...state, selected, offset, rowCount: rows };
  if (key === "escape") result.outcome = "cancel";
  if (key === "enter") { result.outcome = "confirm"; result.item = state.items[selected]; }
  return result;
}
