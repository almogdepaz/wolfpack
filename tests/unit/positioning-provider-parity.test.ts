import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { PROVIDER_DEFINITIONS } from "../../src/provider-readiness.ts";
import { assets } from "../../src/public-assets.ts";

const REPOSITORY_ROOT = process.cwd();
const LOCKED_POSITIONING =
  "Wolfpack is a self-hosted control room for persistent coding-agent terminals on your own machines.";
const README = readFileSync(join(REPOSITORY_ROOT, "README.md"), "utf8");
const ROOT_LLMS = readFileSync(join(REPOSITORY_ROOT, "llms.txt"), "utf8");
const SITE_INDEX = readFileSync(join(REPOSITORY_ROOT, "site", "index.html"), "utf8");
const SITE_LLMS = readFileSync(join(REPOSITORY_ROOT, "site", "llms.txt"), "utf8");
const SITE_LLMS_FULL = readFileSync(join(REPOSITORY_ROOT, "site", "llms-full.txt"), "utf8");
const PUBLIC_INDEX = readFileSync(join(REPOSITORY_ROOT, "public", "index.html"), "utf8");
const PUBLIC_LLMS_BYTES = readFileSync(join(REPOSITORY_ROOT, "public", "llms.txt"));
const PUBLIC_LLMS = PUBLIC_LLMS_BYTES.toString("utf8");
const INSTALLER = readFileSync(join(REPOSITORY_ROOT, "install.sh"), "utf8");
const PROVIDER_DISPLAY_NAMES = PROVIDER_DEFINITIONS.map(({ displayName }) => displayName);
const PROVIDER_TAXONOMY =
  `Built-in coding-agent provider choices: ${PROVIDER_DISPLAY_NAMES.join(", ")}.`;
const SHELL_FALLBACK_TAXONOMY = "Shell is the always-available fallback.";
const CUSTOM_PATH_TAXONOMY =
  "Custom commands and wrappers on PATH are supported separately.";
const FALLBACK_TAXONOMY = `${SHELL_FALLBACK_TAXONOMY} ${CUSTOM_PATH_TAXONOMY}`;
const APP_SHELL_FALLBACK_TOKEN = "Shell fallback";
const APP_CUSTOM_COMMANDS_TOKEN = "custom commands";

interface ElementAttributes {
  readonly [name: string]: string;
}

function section(markdown: string, heading: string, nextHeading: string): string {
  const start = markdown.indexOf(heading);
  const end = markdown.indexOf(nextHeading, start + heading.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return markdown.slice(start, end);
}

function attributesFor(document: string, selector: string): readonly ElementAttributes[] {
  const matches: ElementAttributes[] = [];
  new HTMLRewriter().on(selector, {
    element(element) {
      matches.push(Object.fromEntries(element.attributes));
    },
  }).transform(document);
  return matches;
}

function textFor(document: string, selector: string): readonly string[] {
  const matches: string[] = [];
  new HTMLRewriter().on(selector, {
    element() {
      matches.push("");
    },
    text(text) {
      const index = matches.length - 1;
      const current = matches[index];
      if (current !== undefined) matches[index] = current + text.text;
    },
  }).transform(document);
  return matches.map(value => value.trim());
}

function oneAttribute(document: string, selector: string, name: string): string {
  const matches = attributesFor(document, selector);
  expect(matches).toHaveLength(1);
  const value = matches[0]?.[name];
  expect(value).toBeDefined();
  return value ?? "";
}

function metadataDescriptions(
  document: string,
  includeStructuredData: boolean,
): readonly string[] {
  const descriptions = [
    oneAttribute(document, 'meta[name="description"]', "content"),
    oneAttribute(document, 'meta[property="og:description"]', "content"),
    oneAttribute(document, 'meta[name="twitter:description"]', "content"),
  ];
  if (!includeStructuredData) return descriptions;

  const structuredDataElements = textFor(document, 'script[type="application/ld+json"]');
  expect(structuredDataElements).toHaveLength(1);
  const structuredData: unknown = JSON.parse(structuredDataElements[0] ?? "");
  if (typeof structuredData !== "object" || structuredData === null) {
    throw new Error("JSON-LD must be an object");
  }
  const description = Reflect.get(structuredData, "description");
  expect(typeof description).toBe("string");
  descriptions.push(typeof description === "string" ? description : "");
  return descriptions;
}

function expectMetadataDescriptionParity(
  document: string,
  includeStructuredData = false,
): void {
  for (const description of metadataDescriptions(document, includeStructuredData)) {
    expect(description).toBe(pkg.description);
  }
}

function occurrenceCount(text: string, value: string): number {
  return text.split(value).length - 1;
}

function expectProviderTaxonomy(text: string): void {
  const providerLists = [
    ...text.matchAll(/Built-in coding-agent provider choices: ([^.]+)\./g),
  ].map(match => match[1]?.split(", ") ?? []);

  expect(providerLists).toEqual([PROVIDER_DISPLAY_NAMES]);
  expect(occurrenceCount(text, SHELL_FALLBACK_TAXONOMY)).toBe(1);
  expect(occurrenceCount(text, CUSTOM_PATH_TAXONOMY)).toBe(1);
  expect(text.indexOf(SHELL_FALLBACK_TAXONOMY)).toBeGreaterThan(
    text.indexOf(PROVIDER_TAXONOMY),
  );
  expect(text.indexOf(CUSTOM_PATH_TAXONOMY)).toBeGreaterThan(
    text.indexOf(SHELL_FALLBACK_TAXONOMY),
  );
  expect(text).not.toContain("Codex CLI");
}

function expectProviderOrder(text: string): void {
  const tokens = text.split(",").map(token => token.trim());
  const expectedTaxonomy = [
    ...PROVIDER_DISPLAY_NAMES,
    APP_SHELL_FALLBACK_TOKEN,
    APP_CUSTOM_COMMANDS_TOKEN,
  ];
  const providerStart = tokens.indexOf(PROVIDER_DISPLAY_NAMES[0] ?? "");

  expect(tokens.slice(providerStart, providerStart + expectedTaxonomy.length)).toEqual(
    expectedTaxonomy,
  );
  expect(tokens.filter(token => expectedTaxonomy.includes(token))).toEqual(
    expectedTaxonomy,
  );
  expect(new Set(tokens).size).toBe(tokens.length);
  expect(tokens).not.toContain("Codex CLI");
}

function embeddedPublicIndex(): string {
  const embedded = assets.get("index.html")?.content;
  expect(typeof embedded).toBe("string");
  return typeof embedded === "string" ? embedded : "";
}

function embeddedPublicLlms(): string {
  const embedded = assets.get("llms.txt")?.content;
  expect(typeof embedded).toBe("string");
  return typeof embedded === "string" ? embedded : "";
}

function expectPublicLlmsContract(markdown: string): void {
  const opening = section(markdown, "# Wolfpack", "## Primary links");
  const coreTopics = section(markdown, "## Core topics", "## Important docs");
  const governedRegions = `${opening}\n${coreTopics}`;

  expect(opening).toContain(pkg.description);
  expect(occurrenceCount(governedRegions, pkg.description)).toBe(1);
  expectProviderTaxonomy(governedRegions);
  expect(governedRegions).not.toContain("AI Agent Bridge");
  expect(governedRegions).not.toContain("AI agent terminal orchestrator");
  expect(governedRegions).not.toContain("Codex CLI");
}

describe("canonical positioning and provider parity", () => {
  test("uses the package description as the locked positioning authority", () => {
    expect(pkg.description).toBe(LOCKED_POSITIONING);
  });

  test("keeps npm search keywords category-based instead of a partial provider list", () => {
    const providerKeywordAliases = new Set(
      PROVIDER_DEFINITIONS.flatMap(({ command, displayName }) => [
        command,
        displayName.toLowerCase().replaceAll(" ", "-"),
      ]),
    );

    expect(pkg.keywords.filter(keyword => providerKeywordAliases.has(keyword))).toEqual([]);
  });

  test("uses the package positioning verbatim in primary overview regions", () => {
    const positioning = pkg.description;
    const embeddedIndex = embeddedPublicIndex();
    const overviewRegions = [
      section(README, "# Wolfpack", "## quickstart"),
      section(ROOT_LLMS, "# Wolfpack", "## Primary links"),
      section(SITE_LLMS, "# Wolfpack", "## What it does"),
      section(SITE_LLMS_FULL, "## Summary", "## Activation use case"),
      textFor(SITE_INDEX, ".hero .lede")[0] ?? "",
      oneAttribute(SITE_INDEX, 'meta[name="description"]', "content"),
      oneAttribute(PUBLIC_INDEX, 'meta[name="description"]', "content"),
      oneAttribute(embeddedIndex, 'meta[name="description"]', "content"),
      section(PUBLIC_LLMS, "# Wolfpack", "## Primary links"),
      section(embeddedPublicLlms(), "# Wolfpack", "## Primary links"),
      INSTALLER.slice(INSTALLER.indexOf("cat << 'WOLF'"), INSTALLER.indexOf("# ── Phone and remote access")),
    ];

    for (const region of overviewRegions) expect(region).toContain(positioning);
  });

  test("keeps source and generated metadata descriptions at the package authority", () => {
    expectMetadataDescriptionParity(SITE_INDEX, true);
    expectMetadataDescriptionParity(PUBLIC_INDEX);
    expectMetadataDescriptionParity(embeddedPublicIndex());
  });

  test("rejects generated metadata description drift", () => {
    const embeddedIndex = embeddedPublicIndex();
    const driftedIndex = embeddedIndex.replace(
      pkg.description,
      `${pkg.description} Appended drift.`,
    );
    expect(driftedIndex).not.toBe(embeddedIndex);

    expect(() => expectMetadataDescriptionParity(driftedIndex)).toThrow();
  });

  test("removes competing opening definitions without banning technical vocabulary", () => {
    const primaryClaims = [
      section(ROOT_LLMS, "# Wolfpack", "## Primary links"),
      section(ROOT_LLMS, "## Core topics", "## Important docs"),
      section(SITE_LLMS_FULL, "## Summary", "## Activation use case"),
      section(PUBLIC_LLMS, "# Wolfpack", "## Primary links"),
      section(PUBLIC_LLMS, "## Core topics", "## Important docs"),
      section(embeddedPublicLlms(), "# Wolfpack", "## Primary links"),
      section(embeddedPublicLlms(), "## Core topics", "## Important docs"),
      INSTALLER.slice(INSTALLER.indexOf("cat << 'WOLF'"), INSTALLER.indexOf("# ── Phone and remote access")),
    ].join("\n");

    expect(primaryClaims).not.toContain("AI Agent Bridge");
    expect(primaryClaims).not.toContain("AI agent terminal orchestrator");
    expect(primaryClaims).not.toContain(
      "self-hosted browser terminal manager and multi-machine control room",
    );
  });

  test("derives complete Markdown and agent-readable taxonomy from runtime providers", () => {
    expect(PROVIDER_DISPLAY_NAMES).toHaveLength(5);
    expect(new Set(PROVIDER_DISPLAY_NAMES).size).toBe(PROVIDER_DISPLAY_NAMES.length);

    for (const region of [
      section(README, "# Wolfpack", "## quickstart"),
      section(ROOT_LLMS, "# Wolfpack", "## Primary links"),
      section(SITE_LLMS, "## What it does", "## Privacy and architecture"),
      section(SITE_LLMS_FULL, "## Supported environments", "## Install"),
      `${section(PUBLIC_LLMS, "# Wolfpack", "## Primary links")}\n${section(PUBLIC_LLMS, "## Core topics", "## Important docs")}`,
      `${section(embeddedPublicLlms(), "# Wolfpack", "## Primary links")}\n${section(embeddedPublicLlms(), "## Core topics", "## Important docs")}`,
    ]) expectProviderTaxonomy(region);
  });

  test("keeps public llms source and embedded bytes at the governed contract", () => {
    expect(Buffer.from(embeddedPublicLlms(), "utf8")).toEqual(PUBLIC_LLMS_BYTES);
    expectPublicLlmsContract(PUBLIC_LLMS);
    expectPublicLlmsContract(embeddedPublicLlms());
  });

  test("rejects legacy, omitted, reordered, and conflated public llms mutants", () => {
    const canonicalFixture = `# Wolfpack\n\n${pkg.description}\n\n${PROVIDER_TAXONOMY}\n${SHELL_FALLBACK_TAXONOMY}\n${CUSTOM_PATH_TAXONOMY}\n\n## Primary links\n\n## Core topics\n\n- Persistent terminals\n\n## Important docs\n`;
    const reorderedProviders = [...PROVIDER_DISPLAY_NAMES].reverse();
    const mutants = [
      canonicalFixture.replace(pkg.description, "Wolfpack is an AI Agent Bridge."),
      canonicalFixture.replace(`, ${PROVIDER_DISPLAY_NAMES.at(-1)}`, ""),
      canonicalFixture.replace(
        PROVIDER_TAXONOMY,
        `Built-in coding-agent provider choices: ${reorderedProviders.join(", ")}.`,
      ),
      canonicalFixture.replace(
        `${SHELL_FALLBACK_TAXONOMY}\n${CUSTOM_PATH_TAXONOMY}`,
        "Shell, custom commands, and wrappers on PATH are fallback providers.",
      ),
    ];

    for (const mutant of mutants) {
      expect(() => expectPublicLlmsContract(mutant)).toThrow();
    }
  });

  test("rejects duplicate, reversed, and conflated taxonomy mutants", () => {
    const providers = PROVIDER_DISPLAY_NAMES.join(", ");
    const mutants = [
      {
        name: "duplicated Markdown taxonomy",
        assertRejected: () => expectProviderTaxonomy(
          `${PROVIDER_TAXONOMY} ${FALLBACK_TAXONOMY} ${PROVIDER_TAXONOMY}`,
        ),
      },
      {
        name: "duplicated app provider",
        assertRejected: () => expectProviderOrder(
          `${providers}, Shell fallback, custom commands, ${PROVIDER_DISPLAY_NAMES[0]}`,
        ),
      },
      {
        name: "reversed app fallback and extensibility",
        assertRejected: () => expectProviderOrder(
          `${providers}, custom commands, Shell fallback`,
        ),
      },
      {
        name: "conflated app fallback and extensibility",
        assertRejected: () => expectProviderOrder(
          `${providers}, Shell fallback custom commands`,
        ),
      },
    ];
    const acceptedMutants = mutants.flatMap(({ name, assertRejected }) => {
      try {
        assertRejected();
        return [name];
      } catch {
        return [];
      }
    });

    expect(acceptedMutants).toEqual([]);
  });

  test("keeps homepage built-in providers ordered and Shell/custom separate", () => {
    expect(textFor(SITE_INDEX, ".agent-list span")).toEqual(PROVIDER_DISPLAY_NAMES);
    expect(textFor(SITE_INDEX, ".agent-options")).toEqual([FALLBACK_TAXONOMY]);
    expect(SITE_INDEX).not.toContain("Codex CLI");
  });

  test("keeps app metadata provider keywords complete and non-conflated", () => {
    const sourceKeywords = oneAttribute(PUBLIC_INDEX, 'meta[name="keywords"]', "content");
    const embeddedKeywords = oneAttribute(
      embeddedPublicIndex(),
      'meta[name="keywords"]',
      "content",
    );

    expect(sourceKeywords).toBe(embeddedKeywords);
    expectProviderOrder(sourceKeywords);
  });
});
