import { readFileSync } from "node:fs";

export type PersistenceReadFailure = "unreadable" | "malformed";

export class PersistenceReadError extends Error {
  readonly path: string;
  readonly failure: PersistenceReadFailure;

  constructor(
    label: string,
    path: string,
    failure: PersistenceReadFailure,
    cause?: unknown,
  ) {
    super(`${label} persistence is ${failure}: ${path}`, { cause });
    this.name = "PersistenceReadError";
    this.path = path;
    this.failure = failure;
  }
}

export function readValidatedJsonFile<T>(
  path: string,
  label: string,
  validate: (value: unknown) => value is T,
): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PersistenceReadError(label, path, "unreadable", error);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new PersistenceReadError(label, path, "malformed", error);
  }
  if (!validate(value)) {
    throw new PersistenceReadError(label, path, "malformed");
  }
  return value;
}
