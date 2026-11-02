import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { minifyBrowserIife, APP_MINIFIER_VERSION } from "../../scripts/minify-browser-iife.ts";

const fixture = `/*! @license fixture notice must survive */
(function () {
  let reads = 0;
  const namespace = { get selectedScope() { reads++; return "host/session"; } };
  namespace.selectedScope;
  class PublicClass { constructor(value) { this.publicProperty = value; } method() { return this.publicProperty; } }
  function PublicFunction(a, unused) { return a; }
  const inferredName = (value) => value;
  const methods = { inferredMethod: () => 1 };
  class InferredField { inferredField = () => 2; }
  const object = new PublicClass(namespace.selectedScope);
  console.warn("diagnostic preserved");
  debugger;
  globalThis.__public_hook__ = { selectedScope: object.method(), reads, className: PublicClass.name,
    functionName: PublicFunction.name, arity: PublicFunction.length, inferredName: inferredName.name,
    methodName: methods.inferredMethod.name, fieldName: new InferredField().inferredField.name,
    publicProperty: object.publicProperty, unicode: "界é" };
})();`;
function execute(source: string) {
  const diagnostics: string[] = [];
  const context = { console: { warn: (message: string) => diagnostics.push(message) }, __public_hook__: undefined };
  runInNewContext(source, context);
  return { result: JSON.stringify(context.__public_hook__), diagnostics };
}

test("safe IIFE minification preserves getters, properties, names/arity, hooks, Unicode and diagnostics", async () => {
  const optimized = await minifyBrowserIife(fixture);
  expect(execute(optimized)).toEqual(execute(fixture));
  expect(optimized).toContain("@license fixture notice must survive");
  expect(optimized).toContain("debugger");
  expect(APP_MINIFIER_VERSION).toBe("5.51.2");
});

test("app minification is deterministic and parse failures remain actionable", async () => {
  expect(await minifyBrowserIife(fixture)).toBe(await minifyBrowserIife(fixture));
  await expect(minifyBrowserIife("(() => { invalid syntax ")).rejects.toThrow("app minification failed");
});
