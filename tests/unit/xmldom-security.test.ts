import { describe, expect, test } from "bun:test";
import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";

describe("xmldom security regressions", () => {
  // GHSA-6mj3-qw4j-hgrw: mixed-case raw-text end tags must not amplify output.
  test.each(["script", "style", "textarea", "title"])(
    "parses mixed-case %s closing tags like lowercase tags",
    (tag) => {
      const parser = new DOMParser();
      const serializer = new XMLSerializer();
      const repeatedElements = 3;
      const lowercase = `<html><body>${`<${tag}>x</${tag}>`.repeat(repeatedElements)}</body></html>`;
      const mixedCase = `<html><body>${`<${tag}>x</${tag.toUpperCase()}>`.repeat(repeatedElements)}</body></html>`;

      expect(serializer.serializeToString(parser.parseFromString(mixedCase, "text/html")))
        .toBe(serializer.serializeToString(parser.parseFromString(lowercase, "text/html")));
    },
  );

  // GHSA-6gmq-8vp8-gcm6: reject markup-bearing names at the creation boundary.
  test("rejects invalid entity-reference names without changing valid references", () => {
    const document = new DOMImplementation().createDocument(null, "root", null);
    expect(() => document.createEntityReference("safe; <injected/> &x")).toThrow();
    expect(new XMLSerializer().serializeToString(document.createEntityReference("safe"), {
      requireWellFormed: true,
    })).toBe("&safe;");
  });
});
