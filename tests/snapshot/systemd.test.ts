import { describe, expect, test } from "bun:test";

// ── Replicated from cli.ts (module-private) ──

interface Config {
  devDir: string;
  port: number;
  tailscaleHostname?: string;
}

function systemdEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
}

/**
 * Pure version of generateSystemdUnit — takes config + args instead of reading globals.
 * Mirrors cli.ts generateSystemdUnit() exactly, but parameterized for testing.
 */
function generateSystemdUnit(
  config: Config | null,
  args: string[],
): string {
  const envLines: string[] = [
    `Environment=PATH=/usr/local/bin:/usr/bin:/bin`,
  ];
  if (config?.devDir) envLines.push(`Environment="WOLFPACK_DEV_DIR=${systemdEsc(config.devDir)}"`);
  if (config?.port) envLines.push(`Environment="WOLFPACK_PORT=${config.port}"`);

  const quotedArgs = args.map(a => `"${systemdEsc(a)}"`).join(" ");
  return `[Unit]
Description=Wolfpack AI Agent Bridge
After=network.target

[Service]
Type=simple
ExecStart=${quotedArgs}
Restart=always
RestartSec=5
${envLines.join("\n")}

[Install]
WantedBy=default.target
`;
}

// ── Test fixtures ──

const DEFAULT_CONFIG: Config = { devDir: "/home/user/Dev", port: 18790 };
const DEFAULT_ARGS = ["/usr/bin/bun", "/home/user/Dev/wolfpack/cli.ts"];

// ── Tests ──

describe("generateSystemdUnit", () => {
  describe("snapshot", () => {
    test("matches snapshot with default config", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toMatchSnapshot();
    });

    test("matches snapshot with null config", () => {
      const unit = generateSystemdUnit(null, DEFAULT_ARGS);
      expect(unit).toMatchSnapshot();
    });

    test("matches snapshot with single arg (compiled binary)", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, ["/usr/local/bin/wolfpack"]);
      expect(unit).toMatchSnapshot();
    });

    test("matches snapshot with tailscale config", () => {
      const config: Config = {
        ...DEFAULT_CONFIG,
        tailscaleHostname: "box.tail1234.ts.net",
      };
      const unit = generateSystemdUnit(config, DEFAULT_ARGS);
      expect(unit).toMatchSnapshot();
    });
  });

  describe("ExecStart quoting", () => {
    test("each arg is double-quoted", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain('ExecStart="/usr/bin/bun" "/home/user/Dev/wolfpack/cli.ts"');
    });

    test("single arg is quoted", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, ["/usr/local/bin/wolfpack"]);
      expect(unit).toContain('ExecStart="/usr/local/bin/wolfpack"');
    });

    test("args with spaces are escaped and quoted", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, ["/usr/bin/bun", "/home/user/my project/cli.ts"]);
      expect(unit).toContain('ExecStart="/usr/bin/bun" "/home/user/my project/cli.ts"');
    });

    test("args with backslashes are escaped", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, ["/usr/bin/bun", "C:\\Users\\dev\\cli.ts"]);
      expect(unit).toContain('ExecStart="/usr/bin/bun" "C:\\\\Users\\\\dev\\\\cli.ts"');
    });

    test("args with quotes are escaped", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, ['/usr/bin/bun', '/home/user/"special"/cli.ts']);
      expect(unit).toContain('ExecStart="/usr/bin/bun" "/home/user/\\"special\\"/cli.ts"');
    });

    test("args with newlines are stripped", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, ["/usr/bin/bun", "/home/user/cli\n.ts"]);
      expect(unit).toContain('ExecStart="/usr/bin/bun" "/home/user/cli.ts"');
    });
  });

  describe("Environment escaping", () => {
    test("devDir with backslashes is escaped", () => {
      const config: Config = { devDir: "C:\\Users\\dev", port: 18790 };
      const unit = generateSystemdUnit(config, DEFAULT_ARGS);
      expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=C:\\\\Users\\\\dev"');
    });

    test("devDir with quotes is escaped", () => {
      const config: Config = { devDir: '/home/user/"projects"', port: 18790 };
      const unit = generateSystemdUnit(config, DEFAULT_ARGS);
      expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=/home/user/\\"projects\\""');
    });

    test("devDir with newlines is stripped", () => {
      const config: Config = { devDir: "/home/user/dev\ndir", port: 18790 };
      const unit = generateSystemdUnit(config, DEFAULT_ARGS);
      expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=/home/user/devdir"');
    });

    test("combined escaping: backslash + quote + newline", () => {
      const config: Config = { devDir: 'C:\\"test\ndir"', port: 18790 };
      const unit = generateSystemdUnit(config, DEFAULT_ARGS);
      expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=C:\\\\\\"testdir\\""');
    });

    test("port is unquoted number (no escaping needed)", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain('Environment="WOLFPACK_PORT=18790"');
    });

    test("omits devDir env when config is null", () => {
      const unit = generateSystemdUnit(null, DEFAULT_ARGS);
      expect(unit).not.toContain("WOLFPACK_DEV_DIR");
    });

    test("omits port env when config is null", () => {
      const unit = generateSystemdUnit(null, DEFAULT_ARGS);
      expect(unit).not.toContain("WOLFPACK_PORT");
    });

    test("port 0 is falsy — omitted from env", () => {
      const config: Config = { devDir: "/home/user/dev", port: 0 };
      const unit = generateSystemdUnit(config, DEFAULT_ARGS);
      expect(unit).not.toContain("WOLFPACK_PORT");
      // devDir still present
      expect(unit).toContain("WOLFPACK_DEV_DIR");
    });

    test("PATH is always present (hardcoded)", () => {
      const unit = generateSystemdUnit(null, DEFAULT_ARGS);
      expect(unit).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin");
    });

    test("PATH line is unquoted (no special chars)", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      // PATH line has no quotes — unlike WOLFPACK_* lines
      expect(unit).toMatch(/^Environment=PATH=\/usr\/local\/bin/m);
      expect(unit).not.toMatch(/^Environment="PATH=/m);
    });
  });

  describe("structure", () => {
    test("starts with [Unit] section", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toStartWith("[Unit]");
    });

    test("contains [Service] section", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain("[Service]");
    });

    test("contains [Install] section", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain("[Install]");
    });

    test("sections appear in correct order", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      const unitIdx = unit.indexOf("[Unit]");
      const serviceIdx = unit.indexOf("[Service]");
      const installIdx = unit.indexOf("[Install]");
      expect(unitIdx).toBeLessThan(serviceIdx);
      expect(serviceIdx).toBeLessThan(installIdx);
    });

    test("Description is Wolfpack AI Agent Bridge", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain("Description=Wolfpack AI Agent Bridge");
    });

    test("starts after network.target", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain("After=network.target");
    });

    test("Type is simple", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain("Type=simple");
    });

    test("Restart is always with 5s delay", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain("Restart=always");
      expect(unit).toContain("RestartSec=5");
    });

    test("WantedBy is default.target", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toContain("WantedBy=default.target");
    });

    test("ends with newline", () => {
      const unit = generateSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
      expect(unit).toEndWith("\n");
    });
  });
});
