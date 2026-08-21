import { describe, expect, test } from "bun:test";
import { esc, escAttr } from "../../src/html-escape.ts";
import { systemdEsc, xmlEsc } from "../../src/validation.ts";

describe("xmlEsc", () => {
  test.each([
    ["ampersand", "a&b", "a&amp;b"],
    ["less-than", "a<b", "a&lt;b"],
    ["greater-than", "a>b", "a&gt;b"],
    ["double quote", 'a"b', "a&quot;b"],
    ["single quote", "a'b", "a&apos;b"],
    ["combined hostile payload", `&<>"'`, "&amp;&lt;&gt;&quot;&apos;"],
    ["clean", "hello world 123", "hello world 123"],
    ["empty", "", ""],
    ["whitespace preserved", "a\tb\nc", "a\tb\nc"],
  ])("escapes %s", (_label, input, expected) => {
    expect(xmlEsc(input)).toBe(expected);
  });
});

describe("systemdEsc", () => {
  test.each([
    ["backslash", "a\\b", "a\\\\b"],
    ["double quote", 'a"b', 'a\\"b'],
    ["newline stripped", "line1\nline2", "line1line2"],
    ["combined hostile payload", 'path\\to\n"file"', 'path\\\\to\\"file\\"'],
    ["clean", "hello", "hello"],
    ["empty", "", ""],
    ["only newlines", "\n\n", ""],
  ])("escapes %s", (_label, input, expected) => {
    expect(systemdEsc(input)).toBe(expected);
  });
});

describe("esc html text", () => {
  test.each([
    ["ampersand", "a&b", "a&amp;b"],
    ["less-than", "a<b", "a&lt;b"],
    ["greater-than", "a>b", "a&gt;b"],
    ["double quote", 'a"b', "a&quot;b"],
    ["single quote", "a'b", "a&#39;b"],
    ["combined hostile payload", `<a href="x" onclick='y'>&`, "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;"],
    ["clean", "hello world", "hello world"],
    ["empty", "", ""],
    ["null", null, ""],
    ["undefined", undefined, ""],
    ["number", 42, "42"],
  ])("escapes %s", (_label, input, expected) => {
    expect(esc(input)).toBe(expected);
  });
});

describe("escAttr JavaScript-string attribute", () => {
  test.each([
    ["single quote", "it's", "it\\'s"],
    ["double quote", 'say "hi"', 'say \\"hi\\"'],
    ["backslash", "a\\b", "a\\\\b"],
    ["less-than", "<script", "\\x3cscript"],
    ["greater-than", "script>", "script\\x3e"],
    ["ampersand", "a&b", "a\\x26b"],
    ["newline", "line1\nline2", "line1\\nline2"],
    ["carriage return", "line1\rline2", "line1\\rline2"],
    ["tab", "a\tb", "a\\tb"],
    ["combined hostile payload", `"><script>alert('xss')</script>`, `\\"\\x3e\\x3cscript\\x3ealert(\\'xss\\')\\x3c/script\\x3e`],
    ["clean", "hello", "hello"],
    ["empty", "", ""],
    ["null", null, ""],
    ["undefined", undefined, ""],
    ["number", 42, "42"],
  ])("escapes %s", (_label, input, expected) => {
    expect(escAttr(input)).toBe(expected);
  });
});
