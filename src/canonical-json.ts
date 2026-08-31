function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      values.push(index in value ? canonicalValue(value[index]) : "null");
    }
    return `[${values.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined);
    keys.sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical JSON accepts only JSON values");
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}
