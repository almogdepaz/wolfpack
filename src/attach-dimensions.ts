export interface AttachDimensions {
  readonly cols: number;
  readonly rows: number;
}

export type AttachDimensionAction =
  | { readonly kind: "send" }
  | { readonly kind: "retry"; readonly nextAttempt: number }
  | { readonly kind: "fail" };

export function nextAttachDimensionAction(
  dimensions: AttachDimensions | null,
  attempt: number,
  maxAttempts: number,
): AttachDimensionAction {
  if (dimensions) return { kind: "send" };
  if (attempt < maxAttempts) return { kind: "retry", nextAttempt: attempt + 1 };
  return { kind: "fail" };
}
