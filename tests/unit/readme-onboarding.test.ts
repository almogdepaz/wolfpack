import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { assets } from "../../src/public-assets.ts";

const README_PATH = "README.md";
const INSTALLATION_GUIDE_PATH = "docs/installation.md";
const ROOT_LLMS_PATH = "llms.txt";
const PUBLIC_LLMS_PATH = "public/llms.txt";
const SITE_PATH = "site/index.html";
const SITE_DEMO_PATH = "site/assets/wolfpack-usage-demo.d331794bfd000e0e.mp4";
const MOBILE_SCREENSHOTS = [
  "docs/mobile-sessions.png",
  "docs/mobile-ghostty.png",
] as const;
const SITE_MOBILE_SCREENSHOTS = [
  "site/assets/mobile-sessions.c3bba982771177b1.webp",
  "site/assets/mobile-terminal.7b1d31b4155c4e26.webp",
] as const;
const CURL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash";
const BUNX_COMMAND = "bunx wolfpack-bridge@latest";
const NPX_COMMAND = "npx --yes wolfpack-bridge@latest";
const CURL_HANDOFF = "The installer immediately launches setup. After setup, if you accepted the login service, open the printed URL. If you declined the login service, run `wolfpack`, then open the printed URL. In either case, run `wolfpack doctor` to verify the installation.";
const RUNNER_PREFIX = "Package runners do not add `wolfpack` to `PATH`; repeat the runner prefix for every later command.";
const ROOT_INSTALLATION_ROUTE = "docs/installation.md";
const PUBLIC_INSTALLATION_ROUTE =
  "https://github.com/almogdepaz/wolfpack/blob/main/docs/installation.md";

function curlSection(markdown: string): string {
  const section = markdown.match(/### curl installer:[\s\S]+?(?=\n### )/)?.[0];
  expect(section).toBeDefined();
  return section ?? "";
}

function shellFenceBlocks(markdown: string): readonly (readonly string[])[] {
  const blocks: string[][] = [];
  Bun.markdown.render(markdown, {
    code: (children, metadata) => {
      if (["bash", "sh", "shell", "zsh"].includes(metadata?.language ?? "")) {
        blocks.push(children.split("\n").map((line) => line.trim()).filter(Boolean));
      }
      return children;
    },
  });
  return blocks;
}

function shellFenceCommands(markdown: string): readonly string[] {
  return shellFenceBlocks(markdown).flat();
}

function installSection(markdown: string): string {
  const heading = "## Install\n";
  const start = markdown.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const nextHeading = markdown.indexOf("\n## ", start + heading.length);
  expect(nextHeading).toBeGreaterThan(start);
  return markdown.slice(start, nextHeading);
}

function embeddedPublicLlms(): string {
  const embedded = assets.get("llms.txt")?.content;
  expect(typeof embedded).toBe("string");
  return typeof embedded === "string" ? embedded : "";
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

function expectInstallationRoute(section: string, expectedRoute: string): void {
  expect(markdownLinks(section)).toEqual([expectedRoute]);
}

function expectAgentInstallContract(section: string): void {
  const blocks = shellFenceBlocks(section);
  const commands = blocks.flat();
  const runnerStart = section.indexOf("Package runners:");
  expect(runnerStart).toBeGreaterThan(-1);
  const curlPath = section.slice(0, runnerStart);
  const runnerPath = section.slice(runnerStart);

  expect(blocks).toEqual([
    [CURL_COMMAND],
    [BUNX_COMMAND, NPX_COMMAND],
  ]);
  for (const command of [CURL_COMMAND, BUNX_COMMAND, NPX_COMMAND]) {
    expect(commands.filter((candidate) => candidate === command)).toHaveLength(1);
  }
  expect(commands).not.toContain("wolfpack");
  expect(commands).not.toContain("bunx wolfpack-bridge");
  expect(commands).not.toContain("npx wolfpack-bridge");
  expect(curlPath).toContain(CURL_HANDOFF);
  expect(runnerPath).toContain(RUNNER_PREFIX);
}

function canonicalAgentInstallFixture(
  installationRoute = ROOT_INSTALLATION_ROUTE,
): string {
  return `## Install\n\n\`\`\`bash\n${CURL_COMMAND}\n\`\`\`\n\n${CURL_HANDOFF}\n\nPackage runners:\n\n\`\`\`bash\n${BUNX_COMMAND}\n${NPX_COMMAND}\n\`\`\`\n\n${RUNNER_PREFIX}\n\nSee [installation details](${installationRoute}) for the complete installation procedure.`;
}

describe("README onboarding", () => {
  test("gives curl, Bunx, and npm users executable diagnosis and uninstall commands", () => {
    const readme = readFileSync(README_PATH, "utf-8");

    expect(readme).toStartWith("# Wolfpack — browser terminal manager for AI coding agents");

    for (const command of [
      "curl -fsSL https://raw.githubusercontent.com/almogdepaz/wolfpack/main/install.sh | bash",
      "bunx wolfpack-bridge@latest",
      "npx --yes wolfpack-bridge@latest",
      "wolfpack doctor",
      "wolfpack uninstall --yes",
      "bunx wolfpack-bridge@latest doctor",
      "bunx wolfpack-bridge@latest uninstall --yes",
      "npx --yes wolfpack-bridge@latest doctor",
      "npx --yes wolfpack-bridge@latest uninstall --yes",
    ]) expect(readme).toContain(command);
  });

  test("matches the curl installer's immediate setup and service handoff", () => {
    for (const path of [README_PATH, INSTALLATION_GUIDE_PATH]) {
      const section = curlSection(readFileSync(path, "utf-8"));
      const commands = shellFenceCommands(section);
      expect(commands).toContain(CURL_COMMAND);
      expect(commands.filter((command) => command === "wolfpack")).toEqual([]);
      expect(section).toContain("immediately launches setup");
      expect(section).toContain("accepted the login service");
      expect(section).toContain("open the printed URL");
      expect(section).toContain("declined the login service");
      expect(section).toContain("run `wolfpack`");
      expect(section).toContain("run `wolfpack doctor`");
    }
  });

  test("keeps agent-readable install sections on the accepted lifecycle", () => {
    const publicLlmsBytes = readFileSync(PUBLIC_LLMS_PATH);
    const documents = [
      readFileSync(ROOT_LLMS_PATH, "utf8"),
      publicLlmsBytes.toString("utf8"),
      embeddedPublicLlms(),
    ];

    expect(Buffer.from(embeddedPublicLlms(), "utf8")).toEqual(publicLlmsBytes);
    for (const document of documents) {
      expectAgentInstallContract(installSection(document));
    }
  });

  test("routes each real agent-readable surface to reachable installation details", () => {
    const rootInstall = installSection(readFileSync(ROOT_LLMS_PATH, "utf8"));
    const publicLlmsBytes = readFileSync(PUBLIC_LLMS_PATH);
    const publicInstall = installSection(publicLlmsBytes.toString("utf8"));
    const embeddedLlms = embeddedPublicLlms();
    const embeddedInstall = installSection(embeddedLlms);

    expectInstallationRoute(rootInstall, ROOT_INSTALLATION_ROUTE);
    expectInstallationRoute(publicInstall, PUBLIC_INSTALLATION_ROUTE);
    expectInstallationRoute(embeddedInstall, PUBLIC_INSTALLATION_ROUTE);
    expect(Buffer.from(embeddedLlms, "utf8")).toEqual(publicLlmsBytes);
  });

  test("rejects focused agent-readable install sequencing mutants", () => {
    const canonical = canonicalAgentInstallFixture();
    const mutants = [
      canonical.replace(`${CURL_COMMAND}\n\`\`\``, `${CURL_COMMAND}\nwolfpack\n\`\`\``),
      canonical.replace("if you accepted the login service, open the printed URL. ", ""),
      canonical.replace("If you declined the login service, run `wolfpack`, then open the printed URL. ", ""),
      canonical.replace(BUNX_COMMAND, "bunx wolfpack-bridge"),
      canonical.replace(RUNNER_PREFIX, "Package runners do not add `wolfpack` to `PATH`."),
    ];

    expectAgentInstallContract(canonical);
    for (const mutant of mutants) {
      expect(() => expectAgentInstallContract(mutant)).toThrow();
    }
  });

  test("rejects a relative installation route on the public runtime surface", () => {
    const canonical = canonicalAgentInstallFixture(PUBLIC_INSTALLATION_ROUTE);
    const relativeRuntimeMutant = canonical.replace(
      PUBLIC_INSTALLATION_ROUTE,
      ROOT_INSTALLATION_ROUTE,
    );

    expectInstallationRoute(canonical, PUBLIC_INSTALLATION_ROUTE);
    expect(() => {
      expectInstallationRoute(relativeRuntimeMutant, PUBLIC_INSTALLATION_ROUTE);
    }).toThrow();
  });

  test("links agent overviews to the installation authority", () => {
    expect(existsSync(INSTALLATION_GUIDE_PATH)).toBe(true);

    const readme = readFileSync(README_PATH, "utf-8");
    expect(readme).toContain(INSTALLATION_GUIDE_PATH);
  });

  test("shows representative mobile UI captures after the interactive demo", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    const demoPosition = readme.indexOf("docs/assets/wolfpack-usage-demo.gif");

    const desktopHeadingPosition = readme.indexOf("### desktop demo");
    expect(desktopHeadingPosition).toBeGreaterThan(-1);
    expect(demoPosition).toBeGreaterThan(desktopHeadingPosition);
    const mobileHeadingPosition = readme.indexOf("### mobile views");
    expect(mobileHeadingPosition).toBeGreaterThan(demoPosition);
    for (const screenshot of MOBILE_SCREENSHOTS) {
      expect(existsSync(screenshot)).toBe(true);
      expect(readme.indexOf(screenshot)).toBeGreaterThan(mobileHeadingPosition);
    }
  });

  test("uses the interactive demo as the homepage's first product preview", () => {
    const site = readFileSync(SITE_PATH, "utf-8");
    const hero = site.match(/<div class="hero-visual">([\s\S]*?)<\/section>/)?.[1];

    expect(hero).toBeDefined();
    expect(existsSync(SITE_DEMO_PATH)).toBe(true);
    expect(hero?.match(/<source src="([^"]+)"/)?.[1]).toBe(
      SITE_DEMO_PATH.replace("site/", ""),
    );
  });

  test("places the mobile dashboard and terminal directly after the homepage demo", () => {
    const site = readFileSync(SITE_PATH, "utf-8");
    const demoPosition = site.indexOf(SITE_DEMO_PATH.replace("site/", ""));
    const mobilePosition = site.indexOf('id="mobile"');
    const proofPosition = site.indexOf("BUILT FOR THE MOMENT BETWEEN MACHINES");
    const workflowPosition = site.indexOf('id="how"');
    const privacyPosition = site.indexOf('id="privacy"');
    const desktopPosition = site.indexOf("assets/desktop-terminal.efc351dcb92f63c7.png");

    expect(mobilePosition).toBeGreaterThan(demoPosition);
    expect(proofPosition).toBeGreaterThan(mobilePosition);
    expect(workflowPosition).toBeGreaterThan(mobilePosition);
    expect(privacyPosition).toBeGreaterThan(mobilePosition);
    expect(desktopPosition).toBeGreaterThan(mobilePosition);
    for (const screenshot of SITE_MOBILE_SCREENSHOTS) {
      expect(existsSync(screenshot)).toBe(true);
      expect(site.indexOf(screenshot.replace("site/", ""))).toBeGreaterThan(mobilePosition);
    }
    expect(site).toContain("Scan the dashboard");
    expect(site).toContain("Open the live terminal");
  });
});
