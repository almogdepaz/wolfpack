import { expect, test } from "bun:test";
import { forwardNotificationTestResult } from "./fixtures/run-notification-test.ts";
import type { OwnedBunTestResult } from "./fixtures/run-owned-bun-test.ts";

const success: OwnedBunTestResult = {
  code: 0,
  signal: null,
  stdout: "child stdout\n",
  stderr: "child stderr\n",
  cleanupDiagnostics: [],
};

test("successful notification runner output preserves both streams without spurious warnings", () => {
  const stdout: string[] = [], stderr: string[] = [];
  forwardNotificationTestResult(success, text => stdout.push(text), text => stderr.push(text));
  expect(stdout).toEqual([success.stdout]);
  expect(stderr).toEqual([success.stderr]);
});

test("successful notification runner output preserves complete structured cleanup diagnostics", () => {
  const diagnostics: OwnedBunTestResult["cleanupDiagnostics"] = [
    { phase: "group-probe", code: "EPERM", message: "recovered probe uncertainty" },
    { phase: "group-probe", code: "EACCES", message: "second recovered diagnostic" },
  ];
  const result: OwnedBunTestResult = { ...success, cleanupDiagnostics: diagnostics };
  const stdout: string[] = [], stderr: string[] = [];
  forwardNotificationTestResult(result, text => stdout.push(text), text => stderr.push(text));
  expect(stdout).toEqual([success.stdout]);
  expect(stderr[0]).toBe(success.stderr);
  expect(stderr).toHaveLength(2);
  expect(JSON.parse(stderr[1])).toEqual({
    level: "warn",
    component: "notification-fixture",
    cleanupDiagnostics: diagnostics,
  });
});
