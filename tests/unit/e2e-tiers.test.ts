import { expect, test } from "bun:test";
import { checkTiers, tierFiles } from "../../scripts/e2e-tiers";

const file = "smoke.e2e.ts";
const projects = ["desktop", "iphone-se", "iphone-14"];
const complete = () => ({ pr: { [file]: { projects: [...projects] } }, full: {}, quarantine: {} });

test("every e2e spec/project pair belongs to exactly one tier", () => {
  expect(checkTiers()).toEqual([]);
});

test("disjoint projects of one spec can belong to different tiers", () => {
  expect(checkTiers({
    pr: { [file]: { projects: ["desktop"] } },
    full: { [file]: { projects: ["iphone-se"] } },
    quarantine: { [file]: { projects: ["iphone-14"], reason: "intermittent assertion failure", failing: ["smoke test"] } },
  }, [file])).toEqual([]);
});

test("duplicate pair membership fails, including a repeated project in one tier", () => {
  const manifest = complete();
  expect(checkTiers({ ...manifest, full: manifest.pr }, [file]))
    .toContain(`${file} [desktop]: assigned to pr and full`);
  manifest.pr[file].projects.push("desktop");
  expect(checkTiers(manifest, [file])).toContain(`${file} [desktop]: assigned to pr and pr`);
});

test("missing files and unassigned projects name the affected spec", () => {
  const manifest = complete();
  manifest.pr[file].projects = ["desktop"];
  expect(checkTiers(manifest, [file])).toContain(`${file} [iphone-se]: in no tier`);
  expect(checkTiers(complete(), [])).toContain(`${file}: listed in pr but missing on disk`);
});

test("invalid project selections fail instead of silently selecting no files", () => {
  const manifest = complete();
  manifest.pr[file].projects.push("typo", "mobile-webkit");
  expect(checkTiers(manifest, [file])).toContain(`${file}: unknown project typo`);
  expect(checkTiers(manifest, [file])).toContain(`${file}: not matched by project mobile-webkit`);
  expect(() => tierFiles("pr", "typo")).toThrow("unknown project: typo");
});

test("malformed entries and unexplained quarantine fail", () => {
  expect(checkTiers(null, [])).toEqual(["tiers: expected an object"]);
  expect(checkTiers({ ...complete(), prs: {} }, [file])).toContain("unknown tier: prs");
  expect(checkTiers({ pr: { [file]: {} }, full: {}, quarantine: {} }, [file]))
    .toContain(`${file}: pr needs a nonempty projects array`);
  const errors = checkTiers({ pr: {}, full: {}, quarantine: { [file]: { projects } } }, [file]);
  expect(errors).toContain(`${file}: quarantine needs a one-line reason`);
  expect(errors).toContain(`${file}: quarantine needs failing test titles`);
});

test("project selection retains green CI subsets and the approved machine-groups desktop", () => {
  expect(tierFiles("pr", "desktop")).toContain("tests/e2e/machine-groups.e2e.ts");
  expect(tierFiles("pr", "mobile-webkit")).toContain("tests/e2e/extensions-frontend.e2e.ts");
  expect(tierFiles("quarantine", "desktop")).toContain("tests/e2e/extensions-frontend.e2e.ts");
});
