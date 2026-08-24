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

export function validateControlApiSchemaValue(
  schema: unknown,
  value: unknown,
  root: JsonObject,
  path = "$",
): string[] {
  if (!isJsonObject(schema)) return [];
  const resolved = resolveControlApiSchemaRef(schema, root);
  if (resolved !== schema) return validateControlApiSchemaValue(resolved, value, root, path);

  if (Array.isArray(resolved.anyOf)) {
    const variants = resolved.anyOf.map(candidate => validateControlApiSchemaValue(candidate, value, root, path));
    return variants.some(errors => errors.length === 0)
      ? []
      : [`${path} did not match anyOf: ${variants.map(errors => errors.join(", ")).join(" | ")}`];
  }

  if (Array.isArray(resolved.oneOf)) {
    const variants = resolved.oneOf.map(candidate => validateControlApiSchemaValue(candidate, value, root, path));
    return variants.filter(errors => errors.length === 0).length === 1
      ? []
      : [`${path} did not match exactly one variant: ${variants.map(errors => errors.join(", ")).join(" | ")}`];
  }

  if (Array.isArray(resolved.allOf)) {
    const { allOf: _allOf, ...withoutAllOf } = resolved;
    return [
      ...resolved.allOf.flatMap(candidate => validateControlApiSchemaValue(candidate, value, root, path)),
      ...validateControlApiSchemaValue(withoutAllOf, value, root, path),
    ];
  }

  if ("const" in resolved && value !== resolved.const) {
    return [`${path} expected const ${JSON.stringify(resolved.const)}`];
  }
  if (Array.isArray(resolved.enum) && !resolved.enum.some(candidate => candidate === value)) {
    return [`${path} expected one of ${JSON.stringify(resolved.enum)}`];
  }

  if (typeof resolved.type === "string") {
    if (resolved.type === "object" && !isJsonObject(value)) return [`${path} expected object`];
    if (resolved.type === "array" && !Array.isArray(value)) return [`${path} expected array`];
    if (resolved.type === "string" && typeof value !== "string") return [`${path} expected string`];
    if (resolved.type === "number" && typeof value !== "number") return [`${path} expected number`];
    if (resolved.type === "integer" && !Number.isInteger(value)) return [`${path} expected integer`];
    if (resolved.type === "boolean" && typeof value !== "boolean") return [`${path} expected boolean`];
    if (resolved.type === "null" && value !== null) return [`${path} expected null`];
  }

  if (typeof value === "string") {
    const errors: string[] = [];
    if (typeof resolved.minLength === "number" && value.length < resolved.minLength) errors.push(`${path} is too short`);
    if (typeof resolved.maxLength === "number" && value.length > resolved.maxLength) errors.push(`${path} is too long`);
    if (typeof resolved.pattern === "string" && !new RegExp(resolved.pattern).test(value)) errors.push(`${path} failed pattern ${resolved.pattern}`);
    if (resolved.format === "uuid" && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
      errors.push(`${path} expected uuid`);
    }
    if (errors.length > 0) return errors;
  }

  if (typeof value === "number") {
    const errors: string[] = [];
    if (typeof resolved.minimum === "number" && value < resolved.minimum) errors.push(`${path} is below minimum ${resolved.minimum}`);
    if (typeof resolved.maximum === "number" && value > resolved.maximum) errors.push(`${path} is above maximum ${resolved.maximum}`);
    if (errors.length > 0) return errors;
  }

  if (Array.isArray(value)) {
    const errors: string[] = [];
    if (typeof resolved.minItems === "number" && value.length < resolved.minItems) errors.push(`${path} has too few items`);
    if (typeof resolved.maxItems === "number" && value.length > resolved.maxItems) errors.push(`${path} has too many items`);
    if (resolved.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
      errors.push(`${path} has duplicate items`);
    }
    if (isJsonObject(resolved.contains) && !value.some(item => validateControlApiSchemaValue(resolved.contains, item, root, path).length === 0)) {
      errors.push(`${path} is missing a required item`);
    }
    if (isJsonObject(resolved.items)) {
      errors.push(...value.flatMap((item, index) => validateControlApiSchemaValue(resolved.items, item, root, `${path}[${index}]`)));
    }
    return errors;
  }

  if (isJsonObject(value) && isJsonObject(resolved.properties)) {
    const required = Array.isArray(resolved.required) ? resolved.required : [];
    const errors: string[] = [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(resolved.properties)) {
      if (key in value) errors.push(...validateControlApiSchemaValue(child, value[key], root, `${path}.${key}`));
    }
    if (resolved.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in resolved.properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    return errors;
  }

  return [];
}
