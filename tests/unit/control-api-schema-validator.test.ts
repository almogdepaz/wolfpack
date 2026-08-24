import { describe, expect, test } from "bun:test";
import { validateControlApiSchemaValue } from "../control-api-schema-validator.ts";

const root = {};

describe("control api schema validator", () => {
  test("enforces emitted string constraints", () => {
    const schema = { type: "string", minLength: 2, maxLength: 4 };

    expect(validateControlApiSchemaValue(schema, "a", root)).not.toEqual([]);
    expect(validateControlApiSchemaValue(schema, "abcde", root)).not.toEqual([]);
    expect(validateControlApiSchemaValue(schema, "abc", root)).toEqual([]);
  });

  test("enforces emitted numeric constraints", () => {
    const schema = { type: "integer", minimum: 1, maximum: 5 };

    expect(validateControlApiSchemaValue(schema, 0, root)).not.toEqual([]);
    expect(validateControlApiSchemaValue(schema, 6, root)).not.toEqual([]);
    expect(validateControlApiSchemaValue(schema, 3, root)).toEqual([]);
  });

  test("enforces emitted uuid format", () => {
    const schema = { type: "string", format: "uuid" };

    expect(validateControlApiSchemaValue(schema, "not-a-uuid", root)).not.toEqual([]);
    expect(validateControlApiSchemaValue(schema, "550e8400-e29b-41d4-a716-446655440000", root)).toEqual([]);
    expect(validateControlApiSchemaValue(schema, "018f6b48-4b1c-7000-8000-000000000001", root)).toEqual([]);
  });

  test("enforces emitted dependent requirements", () => {
    const schema = {
      type: "object",
      properties: { newProject: {}, newProjectParent: {} },
      dependentRequired: { newProjectParent: ["newProject"] },
    };

    expect(validateControlApiSchemaValue(schema, { newProjectParent: "/tmp" }, root)).not.toEqual([]);
    expect(validateControlApiSchemaValue(schema, { newProject: "child", newProjectParent: "/tmp" }, root)).toEqual([]);
  });
});
