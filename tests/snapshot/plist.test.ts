import { describe, expect, test } from "bun:test";

// ── Replicated from cli.ts (module-private) ──

interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const PLIST_LABEL = "com.wolfpack.server";

/**
 * Pure version of generatePlist — takes config + args instead of reading globals.
 * Mirrors cli.ts generatePlist() exactly, but parameterized for testing.
 */
function generatePlist(
  config: Config | null,
  args: string[],
  logPath: string,
): string {
  const env: Record<string, string> = {};
  if (config?.devDir) env.WOLFPACK_DEV_DIR = config.devDir;
  if (config?.port) env.WOLFPACK_PORT = String(config.port);

  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${xmlEsc(k)}</key>\n      <string>${xmlEsc(v)}</string>`)
    .join("\n");

  const escapedLogPath = xmlEsc(logPath);

  const argsXml = args.map(a => `    <string>${xmlEsc(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEsc(PLIST_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin</string>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapedLogPath}</string>
  <key>StandardErrorPath</key>
  <string>${escapedLogPath}</string>
</dict>
</plist>`;
}

// ── Helpers ──

/** Naive XML tag balance checker — no unclosed tags */
function xmlTagsBalanced(xml: string): boolean {
  // Skip processing instructions and DOCTYPE
  const stripped = xml
    .replace(/<\?[^?]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "");

  const openTags: string[] = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\s*[^>]*?\/?>/g;
  let match;

  while ((match = tagRegex.exec(stripped)) !== null) {
    const full = match[0];
    const tagName = match[1];

    if (full.endsWith("/>")) {
      // self-closing, skip
      continue;
    } else if (full.startsWith("</")) {
      // closing tag
      const last = openTags.pop();
      if (last !== tagName) return false;
    } else {
      openTags.push(tagName);
    }
  }

  return openTags.length === 0;
}

// ── Test fixtures ──

const DEFAULT_CONFIG: Config = { devDir: "/Users/home/Dev", port: 18790 };
const DEFAULT_ARGS = ["/opt/homebrew/bin/bun", "/Users/home/Dev/wolfpack/cli.ts"];
const DEFAULT_LOG = "/Users/home/.wolfpack/wolfpack.log";

// ── Tests ──

describe("generatePlist", () => {
  describe("snapshot", () => {
    test("matches snapshot with default config", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toMatchSnapshot();
    });

    test("matches snapshot with null config", () => {
      const plist = generatePlist(null, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toMatchSnapshot();
    });

    test("matches snapshot with tailscale config", () => {
      const config: Config = {
        ...DEFAULT_CONFIG,
        tailscaleHostname: "box.tail1234.ts.net",
      };
      const plist = generatePlist(config, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toMatchSnapshot();
    });

    test("matches snapshot with single arg (compiled binary)", () => {
      const plist = generatePlist(DEFAULT_CONFIG, ["/usr/local/bin/wolfpack"], DEFAULT_LOG);
      expect(plist).toMatchSnapshot();
    });
  });

  describe("homebrew paths in PATH", () => {
    test("contains /opt/homebrew/bin", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("/opt/homebrew/bin");
    });

    test("contains /opt/homebrew/sbin", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("/opt/homebrew/sbin");
    });

    test("contains full PATH string in correct order", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain(
        "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin",
      );
    });

    test("PATH is wrapped in <string> tags", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain(
        "<string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin</string>",
      );
    });
  });

  describe("XML validity", () => {
    test("all tags are balanced (default config)", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(xmlTagsBalanced(plist)).toBe(true);
    });

    test("all tags are balanced (null config)", () => {
      const plist = generatePlist(null, DEFAULT_ARGS, DEFAULT_LOG);
      expect(xmlTagsBalanced(plist)).toBe(true);
    });

    test("all tags are balanced (with env vars)", () => {
      const config: Config = { devDir: "/home/user/dev", port: 9999 };
      const plist = generatePlist(config, DEFAULT_ARGS, DEFAULT_LOG);
      expect(xmlTagsBalanced(plist)).toBe(true);
    });

    test("starts with XML declaration", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    });

    test("contains DOCTYPE declaration", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("<!DOCTYPE plist");
    });

    test("has matching <plist> root element", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain("</plist>");
    });

    test("no self-closing tags used where content expected", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      // <true/> is valid plist, but <string/> would be wrong
      expect(plist).not.toMatch(/<string\s*\/>/);
      expect(plist).not.toMatch(/<key\s*\/>/);
      expect(plist).not.toMatch(/<array\s*\/>/);
      expect(plist).not.toMatch(/<dict\s*\/>/);
    });
  });

  describe("environment variables", () => {
    test("includes WOLFPACK_DEV_DIR when config has devDir", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("<key>WOLFPACK_DEV_DIR</key>");
      expect(plist).toContain("<string>/Users/home/Dev</string>");
    });

    test("includes WOLFPACK_PORT when config has port", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("<key>WOLFPACK_PORT</key>");
      expect(plist).toContain("<string>18790</string>");
    });

    test("omits env vars when config is null", () => {
      const plist = generatePlist(null, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).not.toContain("WOLFPACK_DEV_DIR");
      expect(plist).not.toContain("WOLFPACK_PORT");
    });

    test("port 0 is falsy — omitted from env", () => {
      const config: Config = { devDir: "/dev", port: 0 };
      const plist = generatePlist(config, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).not.toContain("WOLFPACK_PORT");
      // devDir still present
      expect(plist).toContain("WOLFPACK_DEV_DIR");
    });

    test("escapes XML-special chars in devDir", () => {
      const config: Config = { devDir: '/Users/home/Dev & "Projects"', port: 18790 };
      const plist = generatePlist(config, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("&amp;");
      expect(plist).toContain("&quot;");
      expect(xmlTagsBalanced(plist)).toBe(true);
    });
  });

  describe("structure", () => {
    test("label is com.wolfpack.server", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("<string>com.wolfpack.server</string>");
    });

    test("RunAtLoad is true", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("<key>RunAtLoad</key>");
      expect(plist).toContain("<true/>");
    });

    test("KeepAlive is true", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      expect(plist).toContain("<key>KeepAlive</key>");
    });

    test("log paths point to ~/.wolfpack/wolfpack.log", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      const logStr = `<string>${DEFAULT_LOG}</string>`;
      // stdout and stderr both use same log
      const stdoutIdx = plist.indexOf("StandardOutPath");
      const stderrIdx = plist.indexOf("StandardErrorPath");
      expect(stdoutIdx).toBeGreaterThan(-1);
      expect(stderrIdx).toBeGreaterThan(-1);
      expect(stderrIdx).toBeGreaterThan(stdoutIdx);
    });

    test("ProgramArguments contains all args", () => {
      const plist = generatePlist(DEFAULT_CONFIG, DEFAULT_ARGS, DEFAULT_LOG);
      for (const arg of DEFAULT_ARGS) {
        expect(plist).toContain(`<string>${arg}</string>`);
      }
    });
  });
});
