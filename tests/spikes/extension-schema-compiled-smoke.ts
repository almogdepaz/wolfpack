import { compileStaticDocumentSchema, validateDocumentPayload } from "../../src/extensions/document-contract.ts";

const validator = compileStaticDocumentSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["schemaVersion"], properties: { schemaVersion: { const: 1 } } });
const result = validateDocumentPayload({ schemaVersion: 1 }, validator);
if (!/^[a-f0-9]{64}$/.test(result.digest)) throw new Error("compiled schema validator did not validate payload");
process.stdout.write("extension-schema-compiled-smoke: ok\n");
