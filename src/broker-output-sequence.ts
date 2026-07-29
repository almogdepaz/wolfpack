const DECIMAL_SEQUENCE_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

export type BrokerOutputSequence = string;

export function brokerOutputSequence(value: unknown): BrokerOutputSequence | undefined {
  if (typeof value !== "string" || !DECIMAL_SEQUENCE_PATTERN.test(value)) return undefined;
  return BigInt(value) <= MAX_U64 ? value : undefined;
}

export function brokerOutputAdvanced(
  previous: BrokerOutputSequence | undefined,
  current: BrokerOutputSequence | undefined,
): boolean {
  if (previous === undefined || current === undefined) return false;
  return BigInt(current) > BigInt(previous);
}
