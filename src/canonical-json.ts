export type CanonicalJsonKeyComparator = (left: string, right: string) => number;

type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export function compareCanonicalJsonKeysByLocale(left: string, right: string): number {
  return left.localeCompare(right);
}

function canonicalValue(
  value: unknown,
  compareKeys: CanonicalJsonKeyComparator | undefined,
): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => canonicalValue(child, compareKeys));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined);
    if (compareKeys) keys.sort(compareKeys);
    else keys.sort();
    return Object.fromEntries(keys.map((key) => [key, canonicalValue(record[key], compareKeys)]));
  }
  throw new TypeError("canonical JSON accepts only JSON values");
}

export function canonicalJson(
  value: unknown,
  compareKeys: CanonicalJsonKeyComparator | undefined = undefined,
): string {
  return JSON.stringify(canonicalValue(value, compareKeys));
}
