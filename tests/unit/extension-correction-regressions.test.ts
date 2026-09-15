import { describe, expect, test } from "bun:test";
import { compileStaticDocumentSchema, ExtensionDocumentStore } from "../../src/extensions/document-contract.ts";
import { deployBundledPiSkills } from "../../src/extensions/pi-skill-deployment.ts";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const key = { installationId: "6b57a60c-059e-45cf-a861-92a9161a0e39", scopeSessionId: "0aba983a-fe91-4ca9-9616-1423ce8fae81", extensionId: "agent-context", documentId: "context" };
describe("phase-zero corrective regressions", () => {
 test("allows ordinary property names and literal data that resemble schema keywords", () => {
  expect(() => compileStaticDocumentSchema({ type: "object", properties: { pattern: { type: "string" } }, const: { format: "ordinary data" } })).not.toThrow();
 });
 test("read rejects a record whose stored key is not the hashed requested key", async () => { const root = mkdtempSync(join(tmpdir(), "extension-record-")); try { const store = new ExtensionDocumentStore({ root }); const schema = compileStaticDocumentSchema({ type: "object" }); await store.publish({ key, document: {}, ifRevision: 0, schemaVersion: 1, requestId: "11111111-1111-4111-8111-111111111111" }, schema); const file = join(root, "documents", readdirSync(join(root,"documents"))[0]!); const record=JSON.parse(readFileSync(file,"utf8")); record.key.scopeSessionId="674e2e49-bbc1-4a8b-bcfd-f3f00f5826f0"; writeFileSync(file,JSON.stringify(record)); expect(()=>store.read(key)).toThrow(); } finally { rmSync(root,{recursive:true,force:true}); } });
 test("refuses an update when an owned skill contains an untracked user file", () => { const root=mkdtempSync(join(tmpdir(),"extension-skill-")); const skill=(body:string)=>({name:"wolfpack-context",files:[{path:"SKILL.md",content:`---\nname: wolfpack-context\ndescription: context\n---\n${body}`} ]}); try { expect(deployBundledPiSkills({skillsRoot:root,extensionId:"agent-context",skills:[skill("one") ]})[0]?.status).toBe("installed"); const extra=join(root,"wolfpack-context","notes.txt");writeFileSync(extra,"user"); expect(deployBundledPiSkills({skillsRoot:root,extensionId:"agent-context",skills:[skill("two") ]})[0]?.status).toBe("modified"); expect(existsSync(extra)).toBe(true); } finally {rmSync(root,{recursive:true,force:true});} });
});
