import { canonicalJson } from "../canonical-json.ts";

export interface JsonBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
  readonly maxNodes: number;
}

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate before whole-document serialization; never invoke getters/toJSON. */
export function boundedCanonicalJson(value: unknown, budget: JsonBudget): { canonical: string; nodes: number } {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const addBytes = (count: number) => {
    bytes += count;
    if (bytes > budget.maxBytes) throw new TypeError("JSON exceeds canonical byte limit");
  };
  const stringBytes = (text: string) => {
    if (Buffer.byteLength(text, "utf8") > budget.maxStringBytes) throw new TypeError("JSON string exceeds byte limit");
    addBytes(Buffer.byteLength(JSON.stringify(text), "utf8"));
  };
  const dataProperty = (object: object, name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor || !("value" in descriptor)) throw new TypeError("JSON cannot contain accessors or sparse arrays");
    return descriptor.value;
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > budget.maxNodes || depth > budget.maxDepth) throw new TypeError("JSON exceeds depth or node limit");
    if (typeof item === "string") { stringBytes(item); return; }
    if (item === null || typeof item === "boolean") { addBytes(String(item).length); return; }
    if (typeof item === "number" && Number.isFinite(item)) { addBytes(JSON.stringify(item).length); return; }
    if (!Array.isArray(item) && !isPlainJsonObject(item)) throw new TypeError("JSON must contain only plain JSON data");
    if (ancestors.has(item)) throw new TypeError("JSON cannot contain cycles");
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError("JSON cannot contain symbol properties");
    ancestors.add(item);
    addBytes(2);
    if (Array.isArray(item)) {
      if (item.length > budget.maxArrayItems) throw new TypeError("JSON array exceeds item limit");
      const keys = Object.keys(item);
      if (keys.length !== item.length) throw new TypeError("JSON array has holes or extra properties");
      for (let index = 0; index < item.length; index++) {
        if (index) addBytes(1);
        visit(dataProperty(item, String(index)), depth + 1);
      }
    } else {
      let count = 0;
      // Do not allocate an unbounded Object.entries array before checking width.
      for (const name in item) {
        if (!Object.hasOwn(item, name)) continue;
        if (++count > budget.maxObjectKeys) throw new TypeError("JSON object exceeds key limit");
        if (count > 1) addBytes(1);
        stringBytes(name);
        addBytes(1);
        visit(dataProperty(item, name), depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  // Shared canonicalization is unchanged: other persisted hashes must not move.
  return { canonical: canonicalJson(value), nodes };
}
