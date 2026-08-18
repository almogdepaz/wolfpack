import { describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../../src/cli/doctor.ts";

const REPOSITORY_ROOT = process.cwd();
const BUG_FORM_PATH = ".github/ISSUE_TEMPLATE/bug-report.yml";
const FEATURE_FORM_PATH = ".github/ISSUE_TEMPLATE/feature-request.yml";
const CONFIG_PATH = ".github/ISSUE_TEMPLATE/config.yml";
const PULL_REQUEST_TEMPLATE_PATH = ".github/pull_request_template.md";
const SUPPORT_PATH = "SUPPORT.md";
const SECURITY_PATH = "SECURITY.md";
const DISCUSSIONS_URL = "https://github.com/almogdepaz/wolfpack/discussions";
const SECURITY_ADVISORY_URL =
  "https://github.com/almogdepaz/wolfpack/security/advisories/new";
const BUG_FORM_URL =
  "https://github.com/almogdepaz/wolfpack/issues/new?template=bug-report.yml";
const FEATURE_FORM_URL =
  "https://github.com/almogdepaz/wolfpack/issues/new?template=feature-request.yml";

type UnknownRecord = Record<string, unknown>;
type IssueFieldType = "input" | "textarea" | "dropdown" | "checkboxes";

interface IssueFieldContract {
  readonly id: string;
  readonly type: IssueFieldType;
  readonly label: string;
  readonly descriptionTerms: readonly string[];
  readonly required: boolean;
  readonly options?: readonly string[];
}

const BUG_FIELD_CONTRACTS: readonly IssueFieldContract[] = [
  {
    id: "problem",
    type: "textarea",
    label: "Problem and impact",
    descriptionTerms: ["problem", "affects", "wolfpack"],
    required: true,
  },
  {
    id: "reproduction",
    type: "textarea",
    label: "Minimal reproduction",
    descriptionTerms: ["exact", "minimal", "non-sensitive"],
    required: true,
  },
  {
    id: "expected",
    type: "textarea",
    label: "Expected behavior",
    descriptionTerms: ["expect", "wolfpack"],
    required: true,
  },
  {
    id: "actual",
    type: "textarea",
    label: "Actual behavior",
    descriptionTerms: ["happened", "terminal", "session"],
    required: true,
  },
  {
    id: "version",
    type: "input",
    label: "Wolfpack version",
    descriptionTerms: ["release version", "source commit"],
    required: true,
  },
  {
    id: "os_arch",
    type: "input",
    label: "Operating system and architecture",
    descriptionTerms: ["os version", "architecture", "without a machine name"],
    required: true,
  },
  {
    id: "install_method",
    type: "dropdown",
    label: "Install method",
    descriptionTerms: ["install", "run wolfpack"],
    required: true,
    options: ["curl installer", "Bunx", "npm or npx", "source checkout", "other"],
  },
  {
    id: "access_path",
    type: "dropdown",
    label: "Access path",
    descriptionTerms: ["problem", "occur"],
    required: true,
    options: [
      "local browser or CLI",
      "Tailnet browser or CLI",
      "both local and Tailnet",
    ],
  },
  {
    id: "diagnostic_context",
    type: "textarea",
    label: "Optional sanitized diagnostic context",
    descriptionTerms: ["smallest", "relevant", "inspected", "redacted", "doctor --json"],
    required: false,
  },
];

const FEATURE_FIELD_CONTRACTS: readonly IssueFieldContract[] = [
  {
    id: "problem",
    type: "textarea",
    label: "User problem or use case",
    descriptionTerms: ["concrete problem", "workflow"],
    required: true,
  },
  {
    id: "audience",
    type: "textarea",
    label: "Intended audience",
    descriptionTerms: ["who", "environment"],
    required: true,
  },
  {
    id: "outcome",
    type: "textarea",
    label: "Desired outcome",
    descriptionTerms: ["observable result", "implementation detail"],
    required: true,
  },
  {
    id: "workaround",
    type: "textarea",
    label: "Current workaround",
    descriptionTerms: ["today", "none"],
    required: true,
  },
  {
    id: "alternatives",
    type: "textarea",
    label: "Alternatives considered",
    descriptionTerms: ["approaches", "narrower options"],
    required: true,
  },
  {
    id: "compatibility_security",
    type: "textarea",
    label: "Compatibility and security implications",
    descriptionTerms: ["supported platforms", "privacy", "trust boundaries", "shell-level access"],
    required: true,
  },
];

const ISSUE_FORM_ATTRIBUTE_KEYS: Readonly<Record<string, readonly string[]>> = {
  markdown: ["value"],
  input: ["description", "label", "placeholder", "value"],
  textarea: ["description", "label", "placeholder", "render", "value"],
  dropdown: ["description", "label", "multiple", "options"],
  checkboxes: ["description", "label", "options"],
};

function readRepositoryFile(path: string): string {
  return readFileSync(join(REPOSITORY_ROOT, path), "utf8");
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function parsedYaml(path: string): UnknownRecord {
  return asRecord(Bun.YAML.parse(readRepositoryFile(path)), path);
}

function validateIssueForm(
  form: UnknownRecord,
  path: string,
  fieldContracts: readonly IssueFieldContract[],
): readonly UnknownRecord[] {
  expect(Object.keys(form).sort()).toEqual(["body", "description", "name", "title"]);
  expect(asString(form.name, `${path} name`).length).toBeGreaterThan(4);
  expect(asString(form.description, `${path} description`).length).toBeGreaterThan(12);
  expect(typeof form.title).toBe("string");

  const body = asArray(form.body, `${path} body`).map((entry, index) =>
    asRecord(entry, `${path} body[${index}]`)
  );
  const ids: string[] = [];
  for (const [index, element] of body.entries()) {
    const type = asString(element.type, `${path} body[${index}].type`);
    const attributes = asRecord(
      element.attributes,
      `${path} body[${index}].attributes`,
    );
    const allowedAttributeKeys = ISSUE_FORM_ATTRIBUTE_KEYS[type];
    if (allowedAttributeKeys === undefined) {
      throw new Error(`${path} body[${index}] has unsupported type ${type}`);
    }
    expect(
      Object.keys(attributes).filter(key => !allowedAttributeKeys.includes(key)),
    ).toEqual([]);
    if (type === "markdown") {
      expect(Object.keys(element).sort()).toEqual(["attributes", "type"]);
      expect(Object.keys(attributes)).toEqual(["value"]);
      expect(asString(attributes.value, `${path} markdown value`).length)
        .toBeGreaterThan(10);
      continue;
    }

    expect(Object.keys(element).sort()).toEqual([
      "attributes",
      "id",
      "type",
      "validations",
    ]);
    const id = asString(element.id, `${path} body[${index}].id`);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    ids.push(id);
    expect(asString(attributes.label, `${path} ${id} label`).length).toBeGreaterThan(3);
    const validations = asRecord(element.validations, `${path} ${id} validations`);
    expect(Object.keys(validations)).toEqual(["required"]);
    expect(typeof validations.required).toBe("boolean");
  }
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(fieldContracts.map(({ id }) => id));
  const fields = body.filter(element => typeof element.id === "string");
  for (const [index, contract] of fieldContracts.entries()) {
    const field = fields[index];
    expect(field).toBeDefined();
    if (field === undefined) throw new Error(`missing issue-form field ${contract.id}`);
    expect(field.type).toBe(contract.type);
    expect(isRequired(field)).toBe(contract.required);
    const attributes = asRecord(field.attributes, `${path} ${contract.id} attributes`);
    expect(attributes.label).toBe(contract.label);
    const description = asString(
      attributes.description,
      `${path} ${contract.id} description`,
    ).toLowerCase();
    for (const term of contract.descriptionTerms) {
      expect(description).toContain(term.toLowerCase());
    }
    if (contract.options === undefined) {
      expect(attributes.options).toBeUndefined();
    } else {
      expect(
        asArray(attributes.options, `${path} ${contract.id} options`).map((option, optionIndex) =>
          asString(option, `${path} ${contract.id} options[${optionIndex}]`)
        ),
      ).toEqual([...contract.options]);
    }
  }
  return body;
}

function issueFormBody(path: string): readonly UnknownRecord[] {
  const fieldContracts = path === BUG_FORM_PATH
    ? BUG_FIELD_CONTRACTS
    : FEATURE_FIELD_CONTRACTS;
  return validateIssueForm(parsedYaml(path), path, fieldContracts);
}

function mutatedIssueForm(
  path: string,
  id: string,
  mutate: (field: UnknownRecord) => void,
): UnknownRecord {
  const form = structuredClone(parsedYaml(path));
  const body = asArray(form.body, `${path} body`).map((entry, index) =>
    asRecord(entry, `${path} body[${index}]`)
  );
  const field = body.find(element => element.id === id);
  if (field === undefined) throw new Error(`missing issue-form field ${id}`);
  mutate(field);
  return form;
}

function mutatedMarkdown(
  path: string,
  mutate: (element: UnknownRecord) => void,
): UnknownRecord {
  const form = structuredClone(parsedYaml(path));
  const body = asArray(form.body, `${path} body`).map((entry, index) =>
    asRecord(entry, `${path} body[${index}]`)
  );
  const markdown = body.find(element => element.type === "markdown");
  if (markdown === undefined) throw new Error("missing issue-form markdown element");
  mutate(markdown);
  return form;
}

function bodyField(body: readonly UnknownRecord[], id: string): UnknownRecord {
  const field = body.find(element => element.id === id);
  expect(field, `missing issue-form field ${id}`).toBeDefined();
  return field ?? {};
}

function isRequired(field: UnknownRecord): boolean {
  if (field.validations === undefined) return false;
  return asRecord(field.validations, "field validations").required === true;
}

function markdownLinks(markdown: string): readonly string[] {
  const links: string[] = [];
  Bun.markdown.render(markdown, {
    link: (children, { href }) => {
      links.push(href);
      return children;
    },
  });
  return links;
}

function shellBlocks(markdown: string): readonly string[] {
  const blocks: string[] = [];
  Bun.markdown.render(markdown, {
    code: (children, metadata) => {
      if (["bash", "sh", "shell"].includes(metadata?.language ?? "")) {
        blocks.push(children.trim());
      }
      return children;
    },
  });
  return blocks;
}

async function captureDoctorJson(
  checkGroups: Array<() => CheckResult[]>,
): Promise<{ readonly exitCode: number; readonly payload: UnknownRecord }> {
  const { doctor } = await import("../../src/cli/doctor.ts");
  let output = "";
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    const exitCode = await doctor({ checkGroups, json: true, fix: false });
    return { exitCode, payload: asRecord(JSON.parse(output), "doctor JSON") };
  } finally {
    stdout.mockRestore();
  }
}

function expectSecurityRoutingContract(markdown: string): void {
  const security = markdown.toLowerCase();
  const noPolicyPromise =
    "this routing page makes no response sla, supported-version window, bounty, embargo, disclosure timeline, or severity promise.";

  expect(markdownLinks(markdown)).toEqual([SECURITY_ADVISORY_URL, SUPPORT_PATH]);
  expect(
    markdown.split(`[private GitHub security advisory](${SECURITY_ADVISORY_URL})`).length - 1,
  ).toBe(1);
  expect(security.split("not a public issue or discussion").length - 1).toBe(1);
  for (const risk of [
    "authentication",
    "authorization",
    "command execution",
    "command injection",
    "path-boundary",
    "secret exposure",
    "network-boundary",
  ]) expect(security).toContain(risk);
  for (const reportPart of ["impact", "reproduction", "affected version", "non-production test data"]) {
    expect(security).toContain(reportPart);
  }
  expect(security.split(noPolicyPromise).length - 1).toBe(1);
  const securityWithoutBoundary = security.replace(noPolicyPromise, "");
  for (const policyTerm of [
    "response sla",
    "supported-version window",
    "bounty",
    "embargo",
    "disclosure timeline",
    "severity",
  ]) expect(securityWithoutBoundary).not.toContain(policyTerm);
  for (const affirmativePromise of [
    /\bguarantees?\b/,
    /\b(?:we|wolfpack|project) promises?\b/,
    /\bsupports? every version\b/,
    /\bpays? (?:a )?bounty\b/,
    /\brequires? (?:an? )?embargo\b/,
    /\bassigns? severity\b/,
  ]) expect(securityWithoutBoundary).not.toMatch(affirmativePromise);
  expect(security).toContain("ordinary bugs");
  expect(security).toContain("usage help");
}

describe("community GitHub intake", () => {
  test("uses valid GitHub issue-form YAML without invented automation metadata", () => {
    for (const path of [BUG_FORM_PATH, FEATURE_FORM_PATH]) issueFormBody(path);
  });

  test("rejects malformed issue-form types, options, and field semantics", () => {
    const mutants = [
      {
        name: "invalid access-path options",
        fieldContracts: BUG_FIELD_CONTRACTS,
        form: mutatedIssueForm(BUG_FORM_PATH, "access_path", (field) => {
          asRecord(field.attributes, "access_path attributes").options = ["public internet"];
        }),
      },
      {
        name: "wrong version field type",
        fieldContracts: BUG_FIELD_CONTRACTS,
        form: mutatedIssueForm(BUG_FORM_PATH, "version", (field) => {
          field.type = "textarea";
        }),
      },
      {
        name: "misleading problem label",
        fieldContracts: BUG_FIELD_CONTRACTS,
        form: mutatedIssueForm(BUG_FORM_PATH, "problem", (field) => {
          asRecord(field.attributes, "problem attributes").label = "Additional information";
        }),
      },
      {
        name: "missing actual-behavior description",
        fieldContracts: BUG_FIELD_CONTRACTS,
        form: mutatedIssueForm(BUG_FORM_PATH, "actual", (field) => {
          delete asRecord(field.attributes, "actual attributes").description;
        }),
      },
      {
        name: "misleading compatibility label",
        fieldContracts: FEATURE_FIELD_CONTRACTS,
        form: mutatedIssueForm(FEATURE_FORM_PATH, "compatibility_security", (field) => {
          asRecord(field.attributes, "compatibility attributes").label = "More details";
        }),
      },
    ];
    const acceptedMutants = mutants.flatMap(({ name, form, fieldContracts }) => {
      try {
        validateIssueForm(form, name, fieldContracts);
        return [name];
      } catch {
        return [];
      }
    });

    expect(acceptedMutants).toEqual([]);
  });

  test("rejects unknown element, validation, and type-specific attribute keys", () => {
    const mutants = [
      {
        name: "unknown element key",
        form: mutatedIssueForm(BUG_FORM_PATH, "problem", (field) => {
          field.extra = "unsupported";
        }),
      },
      {
        name: "unknown validation key",
        form: mutatedIssueForm(BUG_FORM_PATH, "problem", (field) => {
          asRecord(field.validations, "problem validations").accepted = true;
        }),
      },
      {
        name: "dropdown attribute on textarea",
        form: mutatedIssueForm(BUG_FORM_PATH, "problem", (field) => {
          asRecord(field.attributes, "problem attributes").multiple = true;
        }),
      },
      {
        name: "misspelled dropdown attribute",
        form: mutatedIssueForm(BUG_FORM_PATH, "access_path", (field) => {
          asRecord(field.attributes, "access_path attributes").option = ["local"];
        }),
      },
      {
        name: "interactive attribute on markdown",
        form: mutatedMarkdown(BUG_FORM_PATH, (element) => {
          asRecord(element.attributes, "markdown attributes").label = "Unsupported";
        }),
      },
    ];
    const acceptedMutants = mutants.flatMap(({ name, form }) => {
      try {
        validateIssueForm(form, name, BUG_FIELD_CONTRACTS);
        return [name];
      } catch {
        return [];
      }
    });

    expect(acceptedMutants).toEqual([]);
  });

  test("requires bounded bug reproduction and environment fields after a privacy warning", () => {
    const body = issueFormBody(BUG_FORM_PATH);
    const expectedIds = BUG_FIELD_CONTRACTS.map(({ id }) => id);
    expect(body.flatMap(element => typeof element.id === "string" ? [element.id] : []))
      .toEqual(expectedIds);
    for (const id of expectedIds.slice(0, -1)) expect(isRequired(bodyField(body, id))).toBe(true);

    const diagnostic = bodyField(body, "diagnostic_context");
    expect(isRequired(diagnostic)).toBe(false);
    const diagnosticIndex = body.indexOf(diagnostic);
    const privacyIndex = body.findIndex((element) => {
      if (element.type !== "markdown") return false;
      const attributes = asRecord(element.attributes, "privacy markdown attributes");
      return asString(attributes.value, "privacy markdown").toLowerCase().includes("privacy");
    });
    expect(privacyIndex).toBeGreaterThan(-1);
    expect(privacyIndex).toBeLessThan(diagnosticIndex);

    const privacy = JSON.stringify(body[privacyIndex]).toLowerCase();
    for (const boundary of [
      "secret",
      "token",
      "config",
      "terminal",
      "session",
      "tailnet",
      "repository",
      "project",
      "home path",
      "machine",
      "unrelated",
    ]) expect(privacy).toContain(boundary);
  });

  test("asks feature reporters for decision context without implying acceptance", () => {
    const body = issueFormBody(FEATURE_FORM_PATH);
    const expectedIds = FEATURE_FIELD_CONTRACTS.map(({ id }) => id);
    expect(body.flatMap(element => typeof element.id === "string" ? [element.id] : []))
      .toEqual(expectedIds);
    for (const id of expectedIds) expect(isRequired(bodyField(body, id))).toBe(true);
    expect(readRepositoryFile(FEATURE_FORM_PATH).toLowerCase()).not.toContain("will be accepted");
  });

  test("disables blank issues and routes help and vulnerabilities away from public defects", () => {
    const config = parsedYaml(CONFIG_PATH);
    expect(Object.keys(config).sort()).toEqual(["blank_issues_enabled", "contact_links"]);
    expect(config.blank_issues_enabled).toBe(false);
    const contacts = asArray(config.contact_links, "contact_links").map((entry, index) =>
      asRecord(entry, `contact_links[${index}]`)
    );
    expect(contacts.map(contact => contact.url)).toEqual([
      DISCUSSIONS_URL,
      SECURITY_ADVISORY_URL,
    ]);
    for (const contact of contacts) {
      expect(asString(contact.name, "contact name").length).toBeGreaterThan(5);
      expect(asString(contact.about, "contact about").length).toBeGreaterThan(12);
    }
  });

  test("provides a concise pull-request template without claiming automation passed", () => {
    const template = readRepositoryFile(PULL_REQUEST_TEMPLATE_PATH);
    for (const heading of [
      "## Summary",
      "## Motivation and scope",
      "## Validation",
      "## User, security, and compatibility impact",
      "## Documentation",
      "## Checklist",
    ]) expect(template).toContain(heading);
    expect(template.split("\n").filter(line => line.startsWith("- [ ]"))).toEqual([
      "- [ ] This change is focused and excludes unrelated refactors.",
      "- [ ] Public text, screenshots, logs, and fixtures contain no secrets or private machine, network, project, path, or session data.",
    ]);
    expect(template.toLowerCase()).not.toContain("automation has passed");
    expect(template.toLowerCase()).not.toContain("all tests pass");
  });
});

describe("support and private security routing", () => {
  test("routes the five support intents from canonical pages without duplicating diagnostics", () => {
    const support = readRepositoryFile(SUPPORT_PATH);
    const security = readRepositoryFile(SECURITY_PATH);
    const contributing = readRepositoryFile("CONTRIBUTING.md");
    const readme = readRepositoryFile("README.md");
    const troubleshooting = readRepositoryFile("docs/troubleshooting.md");

    expect(markdownLinks(support)).toEqual([
      "docs/troubleshooting.md",
      DISCUSSIONS_URL,
      BUG_FORM_URL,
      FEATURE_FORM_URL,
      SECURITY_ADVISORY_URL,
    ]);
    for (const target of [
      "docs/troubleshooting.md",
      DISCUSSIONS_URL,
      BUG_FORM_URL,
      FEATURE_FORM_URL,
      SECURITY_PATH,
    ]) expect(markdownLinks(contributing)).toContain(target);
    expect(markdownLinks(security)).toContain(SECURITY_ADVISORY_URL);
    expect(markdownLinks(security)).toContain(SUPPORT_PATH);
    expect(markdownLinks(readme)).toContain(SUPPORT_PATH);
    expect(markdownLinks(readme)).toContain(SECURITY_PATH);
    expect(markdownLinks(troubleshooting)).toContain("../SUPPORT.md");

    for (const nonCanonical of [security, contributing, readme, troubleshooting]) {
      expect(nonCanonical).not.toContain("wolfpack doctor --json");
    }
  });

  test("documents the exact doctor JSON contract and preserves a failing capture status", async () => {
    const support = readRepositoryFile(SUPPORT_PATH);
    const blocks = shellBlocks(support);
    expect(blocks[0]).toBe("wolfpack doctor --json > wolfpack-doctor.json");
    const capture = blocks[1];
    expect(capture).toBeDefined();
    if (capture === undefined) throw new Error("missing POSIX doctor capture block");
    expect(capture).not.toContain("|| true");
    expect(capture).toContain("doctor_status=$?");

    const fixtureRoot = mkdtempSync(join(tmpdir(), "wolfpack-support-intake-"));
    try {
      const wolfpack = join(fixtureRoot, "wolfpack");
      const fixtureJson = JSON.stringify({
        ok: false,
        counts: { pass: 1, fail: 1, warn: 0 },
        checks: [{ group: "Fixture", name: "server", status: "fail", detail: "unavailable" }],
      });
      writeFileSync(wolfpack, `#!/bin/sh\nprintf '%s\\n' '${fixtureJson}'\nexit 7\n`);
      chmodSync(wolfpack, 0o755);
      const execution = Bun.spawnSync(["/bin/sh", "-c", `${capture}\nprintf '__STATUS__=%s\\n' "$doctor_status"`], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: `${fixtureRoot}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(execution.exitCode, execution.stderr.toString()).toBe(0);
      expect(execution.stdout.toString()).toContain("__STATUS__=7");
      expect(readFileSync(join(fixtureRoot, "wolfpack-doctor.json"), "utf8").trim())
        .toBe(fixtureJson);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }

    const runtime = await captureDoctorJson([() => [
      { name: "ready", group: "Fixture", status: "pass", detail: "available" },
      {
        name: "server",
        group: "Fixture",
        status: "fail",
        detail: "unavailable",
        fixHint: "run setup",
      },
      { name: "optional", group: "Fixture", status: "warn", detail: "not configured" },
    ]]);
    expect(runtime.exitCode).toBe(1);
    expect(runtime.payload.ok).toBe(false);
    expect(runtime.payload.counts).toEqual({ pass: 1, fail: 1, warn: 1 });
    const checks = asArray(runtime.payload.checks, "doctor checks").map((entry, index) =>
      asRecord(entry, `doctor checks[${index}]`)
    );
    expect(checks.map(check => Object.keys(check).sort())).toEqual([
      ["detail", "group", "name", "status"],
      ["detail", "fixHint", "group", "name", "status"],
      ["detail", "group", "name", "status"],
    ]);

    expect(support).toContain("exits nonzero when one or more checks fail");
    for (const field of ["`ok`", "`counts`", "`pass`", "`fail`", "`warn`", "`checks`", "`group`", "`name`", "`status`", "`detail`", "`fixHint`"]) {
      expect(support).toContain(field);
    }
  });

  test("keeps diagnostic sharing optional, inspected, redacted, and bounded", () => {
    const support = readRepositoryFile(SUPPORT_PATH).toLowerCase();
    expect(support).toContain("optional");
    expect(support).toContain("inspect");
    expect(support).toContain("redact");
    for (const exposure of [
      "host-specific",
      "home",
      "project paths",
      "tailnet hostnames",
      "private urls",
      "service-log excerpts",
    ]) expect(support).toContain(exposure);
    for (const prohibition of [
      "secrets",
      "tokens",
      "raw config",
      "terminal",
      "session content",
      "repository",
      "project names",
      "private machine",
      "network identifiers",
      "unrelated logs",
    ]) expect(support).toContain(prohibition);
  });

  test("routes shell-equivalent security risks privately without policy promises", () => {
    expectSecurityRoutingContract(readRepositoryFile(SECURITY_PATH));
  });

  test("rejects public routes, missing private language, and affirmative promises", () => {
    const security = readRepositoryFile(SECURITY_PATH);
    const mutants = [
      {
        name: "public issue route",
        markdown: `${security}\n[Open a public security issue](https://github.com/almogdepaz/wolfpack/issues/new)\n`,
      },
      {
        name: "missing explicit private advisory language",
        markdown: security.replace(
          "[private GitHub security advisory]",
          "[GitHub security advisory]",
        ),
      },
      {
        name: "missing explicit public-channel prohibition",
        markdown: security.replace(", not a public issue or discussion.", "."),
      },
      {
        name: "affirmative policy promises",
        markdown: `${security}\nWolfpack guarantees a 24-hour response SLA, supports every version, pays a bounty, requires an embargo, promises a 30-day disclosure timeline, and assigns severity.\n`,
      },
    ];
    const acceptedMutants = mutants.flatMap(({ name, markdown }) => {
      try {
        expectSecurityRoutingContract(markdown);
        return [name];
      } catch {
        return [];
      }
    });

    expect(acceptedMutants).toEqual([]);
  });
});
