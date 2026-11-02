import { expect, test } from "bun:test";
import { delegationRootSession, projectDelegationSessions, type DelegationSessionLike } from "../../public/delegation-sessions";
import { loadSessionGroupCollapse, projectSessionGroups, saveSessionGroupCollapse, sessionGroupKey, sessionGroupRoot } from "../../public/session-grouping";
const session = (name: string, group: string | null, parent?: string): DelegationSessionLike => ({ name, identity: { wolfpackSessionId: name, ...(parent ? { parentSession: { wolfpackSessionId: parent, wolfpackSessionName: parent } } : {}) }, organization: { group, tags: ["untouched"], revision: 3 } });
test("highest present ancestor governs nested trees even when filtered out", () => {
  const root = session("root", "Ops"), child = session("child", "Ignored", "root"), nested = session("nested", "Other", "child");
  const inventory = [nested, root, child];
  expect(sessionGroupRoot(inventory, nested)).toBe(root);
  const rows = projectDelegationSessions(inventory).filter(row => row.session === nested);
  expect(projectSessionGroups(inventory, rows)).toEqual([{ kind: "group", label: "Ops", rows }]);
  expect(child.organization).toEqual({ group: "Ignored", tags: ["untouched"], revision: 3 });
});
test("orphaned highest present ancestor owns the whole surviving tree", () => {
  const root = session("orphan", "Orphans", "gone"), child = session("child", null, "orphan");
  expect(delegationRootSession([child, root], child)).toBeNull(); // Workspace ownership still requires a present root.
  expect(delegationRootSession([child, root], child, true)).toBe(root);
  expect(sessionGroupRoot([child, root], child)).toBe(root);
  expect(projectSessionGroups([child, root], projectDelegationSessions([child, root])).map(group => [group.label, group.rows.map(row => row.session.name)])).toEqual([["Orphans", ["orphan", "child"]]]);
});
test("stable label ordering preserves supplied manual/urgency order and separates unknown metadata", () => {
  const sessions = [session("z1", "Z"), session("z2", "Z"), session("a", "A"), session("none", null), { name: "old" }, { name: "broken", organization: { status: "unavailable" as const } }];
  const groups = projectSessionGroups(sessions, projectDelegationSessions(sessions));
  expect(groups.map(group => [group.kind, group.label, group.rows.map(row => row.session.name)])).toEqual([["group", "A", ["a"]], ["group", "Z", ["z1", "z2"]], ["group", null, ["none"]], ["unavailable", null, ["broken"]], ["unsupported", null, ["old"]]]);
});
test("unknown ancestors do not claim child metadata is editable; cycles and duplicate identities fail closed", () => {
  const root = { ...session("root", "A"), organization: undefined }, child = session("child", "B", "root");
  expect(projectSessionGroups([root, child], projectDelegationSessions([root, child]))[0].kind).toBe("unsupported");
  const a = session("a", "A", "b"), b = session("b", "B", "a");
  expect(sessionGroupRoot([a, b], a)).toBeNull();
  expect(sessionGroupRoot([a, { ...a }], a)).toBeNull();
});
test("collapse storage is guarded and machine scoped including literal reserved-looking labels", () => {
  expect(sessionGroupKey("a", "group", null)).not.toBe(sessionGroupKey("a", "group", "Ungrouped"));
  expect(sessionGroupKey("a", "group", "Ops")).not.toBe(sessionGroupKey("b", "group", "Ops"));
  expect(loadSessionGroupCollapse({ getItem: () => "broken" }).size).toBe(0);
  expect(loadSessionGroupCollapse({ getItem: () => '[null,42,"ok"]' })).toEqual(new Set(["ok"]));
  expect(saveSessionGroupCollapse({ setItem: () => { throw new Error("denied"); } }, new Set())).toBe(false);
  expect(loadSessionGroupCollapse(null).size).toBe(0);
});
