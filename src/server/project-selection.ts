import { basename, join } from "node:path";
import { isValidProjectName } from "../validation.js";
import { DEV_DIR } from "./dev-dir.js";
import {
  validateExplicitProjectDir,
  validateProjectDir,
} from "./validate-project-dir.js";
import type { ValidateProjectDirResult } from "./validate-project-dir.js";

export interface ExistingProjectSelection {
  readonly project: string;
  readonly projectDir: string;
}

export type ResolveProjectSelectionResult =
  | { readonly ok: true; readonly value: ExistingProjectSelection }
  | { readonly ok: false; readonly code: "invalid" | "not_dir" | "not_found" | "unavailable"; readonly error: string };

export function resolveExistingProjectSelection(input: {
  readonly project?: string;
  readonly projectDir?: string;
}): ResolveProjectSelectionResult {
  if ((input.project === undefined) === (input.projectDir === undefined)) {
    return invalidSelection();
  }

  if (input.project !== undefined) {
    if (!isValidProjectName(input.project)) return invalidSelection();
    return fromValidation(input.project, validateProjectDir(join(DEV_DIR, input.project)));
  }

  const explicitProjectDir = input.projectDir;
  if (explicitProjectDir === undefined) return invalidSelection();
  const validation = validateExplicitProjectDir(explicitProjectDir);
  if (!validation.ok) return validation;
  return {
    ok: true,
    value: {
      project: basename(validation.projectDir) || "root",
      projectDir: validation.projectDir,
    },
  };
}

function fromValidation(
  project: string,
  validation: ValidateProjectDirResult,
): ResolveProjectSelectionResult {
  if (!validation.ok) return validation;
  return { ok: true, value: { project, projectDir: validation.projectDir } };
}

function invalidSelection(): ResolveProjectSelectionResult {
  return { ok: false, code: "invalid", error: "invalid project selection" };
}
