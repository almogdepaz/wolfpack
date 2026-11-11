import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveControlApiSchemaRef(schema: JsonObject, root: JsonObject): JsonObject {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`unsupported ref ${ref}`);
  const definitions = root.$defs;
  const name = ref.slice(prefix.length);
  const definition = isJsonObject(definitions) ? definitions[name] : undefined;
  if (!isJsonObject(definition)) throw new Error(`missing ref ${ref}`);
  return definition;
}

// Composed schemas declare required properties outside the local branch.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, validateSchema: true, addUsedSchema: false });
ajv.addFormat("uuid", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
ajv.addFormat("date-time", {
  validate: (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(s) && !Number.isNaN(Date.parse(s)),
});
const validators = new WeakMap<object, ValidateFunction>();

export function validateControlApiSchemaValue(schema: unknown, value: unknown, root: JsonObject, path = "$"): string[] {
  if (!isJsonObject(schema)) return [];
  let validate = validators.get(schema);
  if (!validate) {
    const input = Object.hasOwn(schema, "$defs") ? schema : { ...schema, $defs: root.$defs };
    validate = ajv.compile(input);
    validators.set(schema, validate);
  }
  if (validate(value)) return [];
  return (validate.errors ?? []).map(error => {
    const base = path + error.instancePath.split("/").slice(1).map(part => {
      const decoded = part.replaceAll("~1", "/").replaceAll("~0", "~");
      return /^\d+$/.test(decoded) ? `[${decoded}]` : `.${decoded}`;
    }).join("");
    return error.keyword === "required"
      ? `${base}.${error.params.missingProperty} is required`
      : `${base} ${error.message}`;
  });
}
