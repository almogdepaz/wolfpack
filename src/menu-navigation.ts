export interface MenuNavigationState {
  readonly itemCount: number;
  readonly selectedIndex: number | null;
  readonly direction: -1 | 1;
}

export function nextMenuSelection(state: MenuNavigationState): number | null {
  if (state.itemCount === 0) return null;
  if (state.selectedIndex === null) return state.direction === 1 ? 0 : state.itemCount - 1;
  return Math.max(0, Math.min(state.itemCount - 1, state.selectedIndex + state.direction));
}
