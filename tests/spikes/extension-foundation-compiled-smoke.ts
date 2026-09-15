import { compileStaticDocumentSchema, validateDocumentPayload } from "../../src/extensions/document-contract.ts";
import { parseExactNpmSpecifier } from "../../src/extensions/package-security.ts";
const validator = compileStaticDocumentSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { schemaVersion: { const: 1 } } });
if (!validateDocumentPayload({ schemaVersion: 1 }, validator).digest || parseExactNpmSpecifier("npm:example@1.2.3").version !== "1.2.3") throw new Error("compiled foundation failed");
process.stdout.write("compiled extension foundations: ok\n");
