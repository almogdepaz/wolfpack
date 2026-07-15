import { describe, expect, test } from "bun:test";
import { renderSystemdUnit, renderBrokerSystemdUnit } from "../../src/cli/service.ts";

const DEFAULT_CONFIG = { devDir: "/home/user/Dev", port: 18790 };
const DEFAULT_ARGS = ["/usr/bin/bun", "/home/user/Dev/wolfpack/cli.ts"];
const SERVICE_AUTH = "/home/user/.wolfpack/service-auth.json";

describe("renderSystemdUnit", () => {
  test("includes service env vars and quoted args", () => {
    const unit = renderSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
    expect(unit).toContain('ExecStart="/usr/bin/bun" "/home/user/Dev/wolfpack/cli.ts"');
    expect(unit).toContain("Environment=WOLFPACK_SERVICE=1");
    expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=/home/user/Dev"');
    expect(unit).toContain('Environment="WOLFPACK_PORT=18790"');
  });

  test("keeps WOLFPACK_SERVICE even without config", () => {
    const unit = renderSystemdUnit(null, DEFAULT_ARGS);
    expect(unit).toContain("Environment=WOLFPACK_SERVICE=1");
    expect(unit).not.toContain("WOLFPACK_DEV_DIR");
    expect(unit).not.toContain("WOLFPACK_PORT");
  });

  test("references private service credentials without embedding the JWT secret", () => {
    const unit = renderSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS, SERVICE_AUTH);
    expect(unit).toContain(`Environment="WOLFPACK_SERVICE_AUTH_FILE=${SERVICE_AUTH}"`);
    expect(unit).not.toContain("WOLFPACK_JWT_SECRET");
  });

  test("supports compiled binary execution", () => {
    const unit = renderSystemdUnit(DEFAULT_CONFIG, ["/usr/local/bin/wolfpack"]);
    expect(unit).toContain('ExecStart="/usr/local/bin/wolfpack"');
  });

  test("escapes special characters in args and env", () => {
    const unit = renderSystemdUnit(
      { devDir: '/home/user/"projects"', port: 18790 },
      ["/usr/bin/bun", '/home/user/"special"/cli.ts'],
    );
    expect(unit).toContain('Environment="WOLFPACK_DEV_DIR=/home/user/\\"projects\\""');
    expect(unit).toContain('ExecStart="/usr/bin/bun" "/home/user/\\"special\\"/cli.ts"');
  });

  test("declares broker as a hard dependency for systemd start ordering", () => {
    const unit = renderSystemdUnit(DEFAULT_CONFIG, DEFAULT_ARGS);
    expect(unit).toContain("Requires=wolfpack-broker.service");
    expect(unit).toContain("After=network.target wolfpack-broker.service");
  });
});

describe("renderBrokerSystemdUnit", () => {
  test("emits a Type=simple unit for the broker binary with Restart=always", () => {
    const unit = renderBrokerSystemdUnit("/home/user/.wolfpack/bin/wolfpack-broker");
    expect(unit).toContain("Description=Wolfpack PTY broker daemon");
    expect(unit).toContain('ExecStart="/home/user/.wolfpack/bin/wolfpack-broker"');
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=always");
  });
});
