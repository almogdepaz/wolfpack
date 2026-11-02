import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { collapseInitialSessionMenu, startTestServer, type TestServer } from "./helpers.ts";
let server: TestServer;
test.beforeAll(async () => { server = await startTestServer({ canonicalSessionIds: true }); });
test.afterAll(async () => { await server?.close(); });

for (const surface of ["dashboard", "sidebar", "drawer"] as const) {
  for (const mixed of [false, true]) {
    test(`headerless free rows ignore obsolete collapse on ${surface} ${mixed ? "mixed" : "all-free"}`, async ({ page, request }, info) => {
      test.skip(surface === "sidebar" ? info.project.name !== "desktop" : surface === "drawer" && info.project.name === "desktop", "chooser viewport ownership");
      const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
      for (const session of sessions) {
        expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: mixed && session.session === "another-project" ? "Named" : null } })).ok()).toBe(true);
      }
      await page.addInitScript(() => localStorage.setItem("wolfpack-session-group-collapse", JSON.stringify([JSON.stringify(["", "group", null])])));
      await page.goto(server.baseUrl);
      if (surface === "sidebar") await collapseInitialSessionMenu(page);
      if (surface === "drawer") {
        await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first().click();
        await page.locator('#session-chip').click();
      }
      const chooser = page.locator(surface === "dashboard" ? '#session-list' : surface === "sidebar" ? '#sidebar-session-list' : '#drawer-list');
      const free = chooser.locator('.session-label-group[data-group-kind="group"][data-group=""]');
      const action = free.getByRole("button", { name: "Move test-project to group", exact: true });
      await expect(action).toBeVisible();
      await expect(free.locator('.session-group-toggle, .session-group-name, small')).toHaveCount(0);
      await expect(free.getByText(/^(Ungrouped|General)$/)).toHaveCount(0);
      const body = free.locator('.session-label-body');
      const firstRow = body.locator(surface === "drawer" ? '.drawer-item-row' : '.card').first();
      expect(await firstRow.evaluate(element => element.getBoundingClientRect().top - element.parentElement!.getBoundingClientRect().top)).toBe(0);
      await expect(chooser.locator('.session-group-toggle')).toHaveCount(mixed ? 1 : 0);
      if (mixed) {
        await chooser.getByRole("button", { name: "Collapse Group “Named”", exact: true }).click();
        await expect(chooser.getByRole("button", { name: "Move another-project to group", exact: true })).not.toBeVisible();
        await expect(action).toBeVisible();
        await chooser.getByRole("button", { name: "Expand Group “Named”", exact: true }).click();
      }
      await page.screenshot({ path: info.outputPath(`free-${surface}-${mixed ? "mixed" : "all"}.png`) });
      if (surface === "drawer") {
        await expect(body).toHaveAttribute("role", "list");
        expect((await new AxeBuilder({ page }).include('#drawer-list').analyze()).violations).toEqual([]);
      } else {
        const machine = chooser.locator('.machine-group[data-machine=""]');
        const toggle = machine.locator('.machine-collapse-toggle');
        await toggle.click();
        await expect(action).not.toBeVisible();
        if (mixed) await expect(machine.locator('.session-group-toggle')).not.toBeVisible();
        await toggle.click(); await expect(action).toBeVisible();
      }
    });
  }
  for (const external of [false, true]) {
    test(`removal to headerless rows retains exact ${surface} focus ${external ? "after external refresh and cancel" : "after save without a free bucket"}`, async ({ page, request }, info) => {
      test.skip(surface === "sidebar" ? info.project.name !== "desktop" : surface === "drawer" && info.project.name === "desktop", "chooser viewport ownership");
      const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
      const source = sessions.find((s: any) => s.session === "test-project");
      for (const session of sessions) {
        const response = await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "Named" } });
        expect(response.ok()).toBe(true); session.organization = (await response.json()).organization;
      }
      await page.addInitScript(() => localStorage.setItem("wolfpack-session-group-collapse", JSON.stringify([JSON.stringify(["", "group", null])])));
      await page.goto(server.baseUrl);
      if (surface === "sidebar") await collapseInitialSessionMenu(page);
      if (surface === "drawer") {
        await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first().click();
        await page.locator('#session-chip').click();
      }
      const chooser = page.locator(surface === "dashboard" ? '#session-list' : surface === "sidebar" ? '#sidebar-session-list' : '#drawer-list');
      await expect(chooser.locator('.session-label-group[data-group=""]')).toHaveCount(0);
      const action = chooser.getByRole("button", { name: "Move test-project to group", exact: true });
      await action.click();
      const select = page.getByLabel("Move to group", { exact: true });
      await select.selectOption({ label: "Remove from group" });
      if (external) {
        expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: source.sessionId, expectedRevision: source.organization.revision, group: null } })).ok()).toBe(true);
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect(chooser.locator('.session-label-group[data-group=""] .organize-btn')).toHaveCount(1);
        await expect(select).toBeFocused();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      } else await page.getByRole("button", { name: "Move", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(action).toBeFocused(); await expect(action).toBeVisible();
      await expect(chooser.locator('.session-label-group[data-group=""] .session-group-toggle')).toHaveCount(0);
      expect((await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${source.sessionId}`)).json()).organization).toMatchObject({ group: null, tags: source.organization.tags });
      const writes: unknown[] = [];
      page.on("request", request => { if (request.url().includes("/session-control/organization") && request.method() === "POST") writes.push(request.postDataJSON()); });
      await action.click(); await page.getByRole("button", { name: "Move", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(action).toBeFocused(); expect(writes).toEqual([]);
      await action.click(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(action).toBeFocused(); expect(writes).toEqual([]);
      if (external) {
        for (const group of ["Named", null]) {
          const current = (await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${source.sessionId}`)).json()).organization;
          expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: source.sessionId, expectedRevision: current.revision, group } })).ok()).toBe(true);
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await expect(chooser.locator(`.session-label-group[data-group="${group ?? ""}"] .organize-btn[data-session-id="${source.sessionId}"]`)).toHaveCount(1);
          await expect(action).toBeFocused(); await expect(action).toBeVisible();
        }
      }
    });
  }
  for (const cancel of [false, true]) {
    test(`external group refresh retains owned ${surface} focus${cancel ? " after cancel" : ""}`, async ({ page, request }, info) => {
      test.skip(surface === "sidebar" ? info.project.name !== "desktop" : surface === "drawer" && info.project.name === "desktop", "chooser viewport ownership");
      const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
      const source = sessions.find((s: any) => s.session === "test-project");
      const destination = sessions.find((s: any) => s.session === "another-project");
      for (const [session, group] of [[source, null], [destination, "Destination"]] as const) {
        const response = await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group } });
        expect(response.ok()).toBe(true); session.organization = (await response.json()).organization;
      }
      await page.goto(server.baseUrl);
      if (surface === "sidebar") await collapseInitialSessionMenu(page);
      if (surface === "drawer") {
        await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first().click();
        await page.locator('#session-chip').click();
      }
      const chooser = page.locator(surface === "dashboard" ? '#session-list' : surface === "sidebar" ? '#sidebar-session-list' : '#drawer-list');
      const toggle = chooser.locator('.session-label-group[data-group="Destination"] .session-group-toggle');
      await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
      const action = chooser.locator('.session-label-group').getByRole("button", { name: "Move test-project to group", exact: true });
      await action.focus(); await expect(action).toBeFocused();
      if (cancel) await action.click();
      expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: source.sessionId, expectedRevision: source.organization.revision, group: "Destination" } })).ok()).toBe(true);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(chooser.locator(`.session-label-group[data-group="Destination"] .organize-btn[data-session-id="${source.sessionId}"]`)).toHaveCount(1);
      if (cancel) {
        await expect(page.getByLabel("Move to group", { exact: true })).toBeFocused();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await expect(toggle).toBeFocused(); await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(action).not.toBeVisible();
      await page.screenshot({ path: info.outputPath(`external-${surface}${cancel ? "-cancel" : ""}.png`) });
    });
  }
  test(`own move into a collapsed group preserves exact ${surface} action focus`, async ({ page, request }, info) => {
    test.skip(surface === "sidebar" ? info.project.name !== "desktop" : surface === "drawer" && info.project.name === "desktop", "chooser viewport ownership");
    const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
    const source = sessions.find((s: any) => s.session === "test-project"), destination = sessions.find((s: any) => s.session === "another-project");
    for (const [session, group] of [[source, null], [destination, "Destination"]] as const) {
      expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group } })).ok()).toBe(true);
    }
    await page.goto(server.baseUrl);
    if (surface === "sidebar") await collapseInitialSessionMenu(page);
    if (surface === "drawer") {
      await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first().click();
      await page.locator('#session-chip').click();
    }
    const chooser = page.locator(surface === "dashboard" ? '#session-list' : surface === "sidebar" ? '#sidebar-session-list' : '#drawer-list');
    const toggle = chooser.locator('.session-label-group[data-group="Destination"] .session-group-toggle');
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const action = chooser.locator('.session-label-group').getByRole("button", { name: "Move test-project to group", exact: true });
    await action.click(); await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "Group “Destination”" });
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(action).toBeVisible(); await expect(action).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const stored = (await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${source.sessionId}`)).json()).organization;
    expect(stored).toMatchObject({ group: "Destination", tags: source.organization.tags });
  });
}

test("reserved-looking groups have distinct presentation and preserve canonical move and clear semantics", async ({ page, request }, info) => {
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const source = sessions.find((s: any) => s.session === "test-project"), destination = sessions.find((s: any) => s.session === "another-project");
  const tags = ["retained reserved-label tag"];
  const seed = await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: source.sessionId, expectedRevision: source.organization.revision, group: null, tags } });
  expect(seed.ok()).toBe(true);
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), data = await response.json();
    data.sessions.find((s: any) => s.name === "prompt-project").organization = null;
    delete data.sessions.find((s: any) => s.name === "error-project").organization;
    await route.fulfill({ response, json: data });
  });
  const chooser = page.locator('#session-list');
  const action = chooser.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first();
  const select = page.getByLabel("Move to group", { exact: true });
  async function stored() { return (await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${source.sessionId}`)).json()).organization; }
  for (const label of ["Ungrouped", "Remove from group", "No group", "New group…", "Grouping unavailable", "Grouping unsupported"]) {
    const response = await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: destination.sessionId, expectedRevision: destination.organization.revision, group: label } });
    expect(response.ok()).toBe(true); destination.organization = (await response.json()).organization;
    await page.goto(server.baseUrl);
    const named = chooser.locator('.session-label-group[data-group-kind="group"]').filter({ has: page.locator(`.session-group-name`, { hasText: `Group “${label}”` }) });
    await expect(named.locator('.session-group-name')).toHaveText(`Group “${label}”`);
    await expect(named.getByRole("button", { name: `Collapse Group “${label}”`, exact: true })).toBeVisible();
    await expect(chooser.locator('.session-label-group[data-group=""] .session-group-toggle')).toHaveCount(0);
    for (const builtin of ["Grouping unavailable", "Grouping unsupported"]) {
      await expect(chooser.getByText(builtin, { exact: true })).toBeVisible();
      await expect(chooser.getByRole("button", { name: `Collapse ${builtin}`, exact: true })).toHaveCount(0);
    }
    await expect(chooser.getByRole("button", { name: "Move prompt-project to group", exact: true })).toBeDisabled();
    await expect(chooser.getByRole("button", { name: "Move error-project to group", exact: true })).toBeDisabled();
    await action.click();
    const options = await select.locator("option").allTextContents();
    expect(new Set(options).size).toBe(options.length);
    expect(options).toContain("Remove from group"); expect(options).toContain("New group…"); expect(options).toContain(`Group “${label}”`);
    await select.selectOption({ label: `Group “${label}”` });
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(await stored()).toMatchObject({ group: label, tags });
    await action.click(); await select.selectOption({ label: "Remove from group" });
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(await stored()).toMatchObject({ group: null, tags });
  }
  await action.click(); await select.selectOption({ label: "New group…" });
  await page.getByLabel("Group", { exact: true }).fill("created through picker");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await stored()).toMatchObject({ group: "created through picker", tags });
  await action.click(); await select.selectOption({ label: "New group…" });
  await page.getByLabel("Group", { exact: true }).fill("retained draft");
  const current = await stored();
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: source.sessionId, expectedRevision: current.revision, group: "Ungrouped" } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(page.locator('.organization-status')).toContainText("Latest saved — Group “Ungrouped”.");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("retained draft");
  expect(await stored()).toMatchObject({ group: "Ungrouped", tags });
  await page.screenshot({ path: info.outputPath("reserved-label-feedback.png") });
  const latest = await stored();
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: source.sessionId, expectedRevision: latest.revision, group: null } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(page.locator('.organization-status')).toContainText("Latest saved — No group.");
  await expect(page.locator('.organization-status')).not.toContainText("Remove from group");
  await expect(page.getByLabel("Group", { exact: true })).toHaveValue("retained draft");
});

test("grouping replaces tag chips with compact actions and collapsible machine buckets", async ({ page, request }, info) => {
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const session = sessions.find((s: any) => s.session === "test-project");
  expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "Operations", tags: ["private retained tag"] } })).ok()).toBe(true);
  await page.goto(server.baseUrl);
  await expect(page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("grouping-dashboard.png") });
  const bucket = page.locator('#session-list .session-label-group[data-group="Operations"]');
  await expect(bucket).toBeVisible();
  await expect(bucket.getByRole("button", { name: "Collapse Group “Operations”", exact: true })).toBeVisible();
  await expect(page.getByText("private retained tag", { exact: true })).toHaveCount(0);
  const more = bucket.getByRole("button", { name: "Move test-project to group", exact: true });
  const box = await more.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  await bucket.getByRole("button", { name: "Collapse Group “Operations”", exact: true }).click();
  await expect(more).not.toBeVisible();
  await expect(bucket.getByRole("button", { name: "Expand Group “Operations”", exact: true })).toBeFocused();
  await page.reload();
  await expect(bucket.getByRole("button", { name: "Expand Group “Operations”", exact: true })).toBeVisible();
  await bucket.getByRole("button", { name: "Expand Group “Operations”", exact: true }).click();
  if (info.project.use.hasTouch) await more.tap(); else await more.click();
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "New group…" });
  await page.getByLabel("Group", { exact: true }).fill("New operations");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const stored = await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${session.sessionId}`)).json();
  expect(stored.organization.group).toBe("New operations");
  expect(stored.organization.tags).toEqual(["private retained tag"]);
  const other = page.getByRole("button", { name: "Move another-project to group", exact: true }).filter({ visible: true }).first();
  await other.click();
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "Group “New operations”" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator('#session-list .session-label-group[data-group="New operations"] .card-name-text')).toHaveText(["another-project", "test-project"]);
  await other.click();
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "Remove from group" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator('#session-list .session-label-group[data-group=""]')).toContainText("another-project");
});

test("pointer drop uses one root CAS, keeps tags, and Escape or an invalid target cannot move", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "mouse shortcut; mobile uses the menu");
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const source = sessions.find((s: any) => s.session === "test-project");
  const target = sessions.find((s: any) => s.session === "another-project");
  for (const session of sessions) {
    const group = session === source ? "Source" : session === target ? "Target" : null;
    const response = await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group, tags: ["keep"] } });
    expect(response.ok()).toBe(true); session.organization = (await response.json()).organization;
  }
  await page.goto(server.baseUrl);
  const card = page.locator(`#session-list .card[data-session-order-id="${source.sessionId}"]`);
  const targetHeader = page.locator('#session-list .session-label-group[data-group="Target"] .session-group-toggle');
  const writes: any[] = [];
  page.on("request", request => { if (request.url().includes("/session-control/organization") && request.method() === "POST") writes.push(request.postDataJSON()); });
  async function startDrag() {
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 24, box.y + box.height / 2, { steps: 3 });
    await expect(page.locator('.session-order-floating')).toHaveCount(1);
  }
  await startDrag();
  let box = (await targetHeader.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.keyboard.press("Escape"); await page.mouse.up();
  expect(writes).toEqual([]);
  await startDrag();
  box = (await targetHeader.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.move(1250, 60, { steps: 10 }); await page.mouse.up();
  expect(writes).toEqual([]);
  await startDrag();
  box = (await targetHeader.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ sessionId: source.sessionId, expectedRevision: source.organization.revision, group: "Target" });
  await expect(page.locator('#session-list .session-label-group[data-group="Target"] .card-name-text')).toHaveText(["another-project", "test-project"]);
  expect((await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${source.sessionId}`)).json()).organization.tags).toEqual(["keep"]);
  await expect(page.locator('#sessions-view')).toHaveClass(/visible/);
  // The existing free rows remain a mouse destination without a synthetic header.
  const free = page.locator('#session-list .session-label-group[data-group-kind="group"][data-group=""]');
  await expect(free.locator('.session-group-toggle')).toHaveCount(0);
  await startDrag();
  box = (await free.locator('.card').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ sessionId: source.sessionId, expectedRevision: writes[0].expectedRevision + 1, group: null });
  await expect(free.locator(`[data-session-order-id="${source.sessionId}"]`)).toBeVisible();
  expect((await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${source.sessionId}`)).json()).organization.tags).toEqual(["keep"]);
});

test("full inventory groups matching nested children under their ancestor and moves only its root", async ({ page, request }, info) => {
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const root = sessions.find((s: any) => s.session === "test-project");
  const child = sessions.find((s: any) => s.session === "another-project");
  const nested = sessions.find((s: any) => s.session === "prompt-project");
  for (const [session, group] of [[root, "Tree"], [child, "Child metadata"], [nested, "Nested metadata"]] as const) {
    expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group, tags: [session.session] } })).ok()).toBe(true);
  }
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), data = await response.json();
    for (const [session, parent] of [[child, root], [nested, child]] as const) {
      const row = data.sessions.find((s: any) => s.identity.wolfpackSessionId === session.sessionId);
      row.identity.parentSession = { wolfpackSessionId: parent.sessionId, wolfpackSessionName: parent.session };
      row.runtimeState = { state: "working", authority: "manifest", freshness: "fresh", source: "local-manifest", stale: false };
    }
    await route.fulfill({ response, json: data });
  });
  await page.goto(server.baseUrl);
  const tree = page.locator('#session-list .session-label-group[data-group="Tree"]');
  await tree.getByRole("button", { name: "Expand 1 child agent", exact: true }).click();
  await tree.getByRole("button", { name: "Expand 1 child agent", exact: true }).click();
  await expect(tree.locator('.card-name-text')).toHaveText(["test-project", "another-project", "prompt-project"]);
  await expect(page.locator('#session-list .session-label-group[data-group="Child metadata"]')).toHaveCount(0);
  await tree.getByRole("button", { name: "Collapse Group “Tree”", exact: true }).click();
  if (info.project.use.hasTouch) await page.locator('.mobile-session-search summary').click();
  const search = page.getByRole("searchbox", { name: "Search sessions" }).filter({ visible: true });
  await search.fill("prompt-project");
  const move = tree.getByRole("button", { name: "Move prompt-project to group", exact: true });
  await expect(move).toBeVisible();
  await expect(tree.getByRole("button", { name: "Open test-project", exact: true })).not.toBeVisible();
  await expect(page.locator('#session-list .session-label-group').filter({ visible: true })).toHaveCount(1);
  const writes: any[] = [];
  page.on("request", request => { if (request.url().includes("/session-control/organization") && request.method() === "POST") writes.push(request.postDataJSON()); });
  await move.click();
  await expect(page.getByText("Moves the whole test-project tree, including all child agents.", { exact: true })).toBeVisible();
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "New group…" });
  await page.getByLabel("Group", { exact: true }).fill("Moved tree");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(writes).toEqual([{ sessionId: root.sessionId, expectedRevision: root.organization.revision + 1, group: "Moved tree" }]);
  for (const [session, group] of [[child, "Child metadata"], [nested, "Nested metadata"]] as const) {
    expect((await (await request.get(`${server.baseUrl}/api/session-control/organization?sessionId=${session.sessionId}`)).json()).organization).toEqual({ group, tags: [session.session], revision: session.organization.revision + 1 });
  }
  await search.fill("");
  if (info.project.use.hasTouch) await page.locator('.mobile-session-search summary').click();
  await expect(page.locator('#session-list .session-label-group[data-group="Moved tree"] .card-name-text')).toHaveText(["test-project", "another-project", "prompt-project"]);
  await page.getByRole("button", { name: /^Working/ }).filter({ visible: true }).click();
  const filtered = page.locator('#session-list .session-label-group[data-group="Moved tree"]');
  await expect(filtered.locator('.card-name-text')).toHaveText(["another-project", "prompt-project"]);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await filtered.locator('.card-name-text').first().evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(80);
  await page.screenshot({ path: info.outputPath("grouping-tree-320.png") });
});

test("grouped drawer preserves accessible session lists when expanded and collapsed", async ({ page, request }, info) => {
  test.skip(info.project.name === "desktop", "mobile drawer semantics");
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  for (const session of sessions) {
    expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: session.session === "test-project" ? "Drawer group" : null } })).ok()).toBe(true);
  }
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Open test-project", exact: true }).filter({ visible: true }).first().click();
  await page.locator('#session-chip').click();
  const drawer = page.locator('#drawer-list');
  await expect(drawer.locator('.drawer-item-row')).toHaveCount(sessions.length);
  expect((await new AxeBuilder({ page }).include('#drawer-list').analyze()).violations).toEqual([]);
  await expect(drawer.getByRole("list")).toHaveCount(2);
  await expect(drawer.getByRole("list", { name: "Group “Drawer group”", exact: true }).getByRole("listitem")).toHaveCount(1);
  await expect(drawer.getByRole("list", { name: "No group", exact: true }).getByRole("listitem")).toHaveCount(sessions.length - 1);
  expect(await drawer.locator('h2, .session-group-toggle').evaluateAll(elements => elements.every(element => !element.closest('[role="list"]')))).toBe(true);
  await page.screenshot({ path: info.outputPath("drawer-lists-expanded.png") });
  await drawer.getByRole("button", { name: "Collapse Group “Drawer group”", exact: true }).tap();
  await expect(drawer.getByRole("list")).toHaveCount(1);
  await expect(drawer.getByRole("list", { includeHidden: true })).toHaveCount(2);
  await expect(drawer.getByRole("button", { name: "Expand Group “Drawer group”", exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).include('#drawer-list').analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("drawer-lists-collapsed.png") });
});

test("served grouping assets are source-bound and grouping controls are accessible", async ({ page, request }) => {
  await page.goto(server.baseUrl);
  await expect(page.locator('#session-list .card').first()).toBeVisible();
  for (const asset of ["app.bundle.js", "styles.css"]) {
    const response = await request.get(`${server.baseUrl}/${asset}`);
    expect(response.ok()).toBe(true);
    expect(await response.body()).toEqual(readFileSync(`public/${asset}`));
  }
  expect((await new AxeBuilder({ page }).include('#session-list').analyze()).violations).toEqual([]);
});

test("no-change and cancellation never post; disappeared UUID does not authorize a reused name", async ({ page, request }) => {
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const original = sessions.find((s: any) => s.session === "test-project");
  let replaced = false;
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), data = await response.json();
    if (replaced) data.sessions.find((s: any) => s.name === "test-project").identity.wolfpackSessionId = "11111111-1111-4111-8111-111111111111";
    await route.fulfill({ response, json: data });
  });
  const writes: any[] = [];
  page.on("request", request => { if (request.url().includes("/session-control/organization") && request.method() === "POST") writes.push(request.postDataJSON()); });
  await page.goto(server.baseUrl);
  const button = page.getByRole("button", { name: "Move test-project to group", exact: true }).filter({ visible: true }).first();
  await button.click(); await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible(); expect(writes).toEqual([]);
  await button.click(); await page.keyboard.press("Escape"); expect(writes).toEqual([]);
  await button.click(); await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "New group…" }); await page.getByLabel("Group", { exact: true }).fill("not reusable");
  replaced = true; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alert")).toContainText("no longer available");
  await expect(page.getByRole("button", { name: "Move", exact: true })).toBeDisabled(); expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-session-id'))).not.toBe(original.sessionId);
});

test("sidebar search updates unchanged grouped markup without stranding matches or empty headers", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "sidebar ownership only");
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  for (const session of sessions) {
    expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group: "Search" } })).ok()).toBe(true);
  }
  await page.goto(server.baseUrl); await collapseInitialSessionMenu(page);
  const search = page.locator('#sidebar-search');
  await search.fill("test-project");
  await expect(page.locator('#sidebar-session-list .card').filter({ visible: true })).toHaveCount(1);
  await search.fill("another-project");
  await expect(page.locator('#sidebar-session-list .card').filter({ visible: true })).toHaveCount(1);
  await expect(page.locator('#sidebar-session-list .card').filter({ visible: true })).toContainText("another-project");
  await expect(page.locator('#sidebar-session-list .session-label-group').filter({ visible: true })).toHaveCount(1);
  await expect(page.locator('#sidebar-session-list .session-group-toggle').filter({ visible: true })).toBeDisabled();
});

test("pointer rejects cross-machine, no-change, refreshed target and replaced source drops", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop", "mouse-only group shortcut");
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const source = sessions.find((s: any) => s.session === "test-project"), target = sessions.find((s: any) => s.session === "another-project");
  for (const [session, group] of [[source, "Source"], [target, "Target"]] as const) {
    expect((await request.post(`${server.baseUrl}/api/session-control/organization`, { data: { sessionId: session.sessionId, expectedRevision: session.organization.revision, group } })).ok()).toBe(true);
  }
  let change: "none" | "source" | "target" = "none";
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), data = await response.json();
    if (change === "source") data.sessions.find((s: any) => s.name === "test-project").identity.wolfpackSessionId = "11111111-1111-4111-8111-111111111111";
    if (change === "target") data.sessions.find((s: any) => s.name === "another-project").organization.group = "Changed target";
    await route.fulfill({ response, json: data });
  });
  const peerOrigin = "https://grouping-peer.example.ts.net";
  await page.route("**/api/tailnet/v1/candidates", route => route.fulfill({ json: { candidates: [{ hostname: "grouping-peer.example.ts.net", tailnetNodeId: "n-grouping", origin: peerOrigin, online: true }] } }));
  await page.route(`${peerOrigin}/api/**`, route => {
    const headers = { "Access-Control-Allow-Origin": "*" }, path = new URL(route.request().url()).pathname;
    if (path === "/api/machine") return route.fulfill({ headers, json: { protocol: { name: "wolfpack-machine", major: 1, minor: 0 }, machine: { tailnetNodeId: "n-grouping", installationId: "22222222-2222-4222-8222-222222222222", displayName: "Remote", origin: peerOrigin }, wolfpack: { version: "1.7.0" }, capabilities: ["sessions", "terminal-websocket", "push-subscription"] } });
    if (path === "/api/backend") return route.fulfill({ headers, json: { backend: "broker", ready: true } });
    if (path === "/api/sessions") return route.fulfill({ headers, json: { sessions: [{ name: "remote", identity: { wolfpackSessionId: "33333333-3333-4333-8333-333333333333" }, organization: { group: "Remote group", tags: [], revision: 0 } }] } });
    return route.fulfill({ headers, status: 404 });
  });
  const writes: any[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/session-control/organization") && request.method() === "POST") writes.push(request.postDataJSON()); });
  for (const scenario of ["cross-machine", "no-change", "target", "source"] as const) {
    change = "none"; await page.goto(server.baseUrl);
    const card = page.locator(`#session-list .card[data-session-order-id="${source.sessionId}"]`);
    await expect(card).toBeVisible(); await expect(page.locator('#session-list .session-label-group[data-group="Remote group"]')).toBeVisible();
    const sourceBox = (await card.boundingBox())!;
    await page.mouse.move(sourceBox.x + 12, sourceBox.y + sourceBox.height / 2); await page.mouse.down();
    await page.mouse.move(sourceBox.x + 24, sourceBox.y + sourceBox.height / 2, { steps: 3 });
    await expect(page.locator('.session-order-floating')).toHaveCount(1);
    const label = scenario === "cross-machine" ? "Remote group" : scenario === "no-change" ? "Source" : "Target";
    const destination = page.locator(`#session-list .session-label-group[data-group="${label}"] .session-group-toggle`);
    const box = (await destination.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    if (scenario === "target" || scenario === "source") {
      const original = await destination.elementHandle(); change = scenario;
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect.poll(() => original!.evaluate(element => element.isConnected)).toBe(false);
    }
    await page.mouse.up(); await expect(page.locator('.session-order-floating')).toHaveCount(0);
    await expect(page.getByRole("dialog")).not.toBeVisible(); expect(writes).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("changing the highest present ancestor invalidates an open child move", async ({ page, request }) => {
  const { sessions } = await (await request.get(`${server.baseUrl}/api/session-control/list`)).json();
  const root = sessions.find((s: any) => s.session === "test-project"), child = sessions.find((s: any) => s.session === "another-project");
  let attached = false;
  await page.route("**/api/sessions", async route => {
    const response = await route.fetch(), data = await response.json();
    if (attached) data.sessions.find((s: any) => s.name === child.session).identity.parentSession = { wolfpackSessionId: root.sessionId, wolfpackSessionName: root.session };
    await route.fulfill({ response, json: data });
  });
  const writes: any[] = [];
  page.on("request", request => { if (request.url().includes("/session-control/organization") && request.method() === "POST") writes.push(request.postDataJSON()); });
  await page.goto(server.baseUrl);
  await page.getByRole("button", { name: "Move another-project to group", exact: true }).filter({ visible: true }).first().click();
  await page.getByLabel("Move to group", { exact: true }).selectOption({ label: "New group…" }); await page.getByLabel("Group", { exact: true }).fill("stale root");
  attached = true; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alert")).toContainText("no longer available");
  await expect(page.getByRole("button", { name: "Move", exact: true })).toBeDisabled(); expect(writes).toEqual([]);
});
