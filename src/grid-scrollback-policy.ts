export const BASE_GRID_TERMINAL_SCROLLBACK = 1000;

export function gridTerminalScrollbackBudget(
  cellCount: number,
  deviceMemoryGb?: number,
): number {
  const cells = Math.max(1, Math.floor(cellCount));
  const memoryScale = deviceMemoryGb !== undefined && deviceMemoryGb < 4 ? 0.5 : 1;
  return Math.max(200, Math.floor((BASE_GRID_TERMINAL_SCROLLBACK * memoryScale) / Math.sqrt(cells)));
}
