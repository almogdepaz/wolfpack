import { describe, expect, test } from "bun:test";
import { xmlEsc, systemdEsc } from "../../validation.ts";

// ── esc and escAttr from index.html (browser functions) ──
// These are inline in index.html and use document.createElement for esc().
// We re-implement the pure logic here to test the escaping contracts.

/** Mirrors index.html esc(): HTML-entity encode then quote-escape */
function esc(s: unknown): string {
  if (s == null) return "";
  const str = String(s);
  // replicate what textContent→innerHTML does: & < > are encoded
  const htmlEncoded = str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // then the function additionally escapes quotes
  return htmlEncoded.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

/** Mirrors index.html escAttr(): JS-safe escaper for onclick="func('...')" */
function escAttr(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\x3c")
    .replace(/>/g, "\\x3e")
    .replace(/&/g, "\\x26");
}

// ── xmlEsc tests ──

describe("xmlEsc", () => {
  test("escapes ampersand", () => {
    expect(xmlEsc("a&b")).toBe("a&amp;b");
  });

  test("escapes less-than", () => {
    expect(xmlEsc("a<b")).toBe("a&lt;b");
  });

  test("escapes greater-than", () => {
    expect(xmlEsc("a>b")).toBe("a&gt;b");
  });

  test("escapes double quotes", () => {
    expect(xmlEsc('a"b')).toBe("a&quot;b");
  });

  test("escapes single quotes", () => {
    expect(xmlEsc("a'b")).toBe("a&apos;b");
  });

  test("escapes all five XML entities together", () => {
    expect(xmlEsc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  test("passes through clean string unchanged", () => {
    expect(xmlEsc("hello world 123")).toBe("hello world 123");
  });

  test("handles empty string", () => {
    expect(xmlEsc("")).toBe("");
  });

  test("handles string with only special chars", () => {
    expect(xmlEsc("<<<>>>")).toBe("&lt;&lt;&lt;&gt;&gt;&gt;");
  });

  test("preserves whitespace", () => {
    expect(xmlEsc("a\tb\nc")).toBe("a\tb\nc");
  });
});

// ── systemdEsc tests ──

describe("systemdEsc", () => {
  test("doubles backslashes", () => {
    expect(systemdEsc("a\\b")).toBe("a\\\\b");
  });

  test("escapes double quotes", () => {
    expect(systemdEsc('a"b')).toBe('a\\"b');
  });

  test("strips newlines", () => {
    expect(systemdEsc("line1\nline2")).toBe("line1line2");
  });

  test("handles backslash + quote + newline together", () => {
    expect(systemdEsc('path\\to\n"file"')).toBe('path\\\\to\\"file\\"');
  });

  test("passes through clean string unchanged", () => {
    expect(systemdEsc("hello")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(systemdEsc("")).toBe("");
  });

  test("doubles multiple consecutive backslashes", () => {
    expect(systemdEsc("a\\\\b")).toBe("a\\\\\\\\b");
  });

  test("strips multiple newlines", () => {
    expect(systemdEsc("\n\n\n")).toBe("");
  });

  test("handles backslash before quote", () => {
    expect(systemdEsc('\\"')).toBe('\\\\\\"');
  });
});

// ── escAttr tests ──

describe("escAttr", () => {
  test("escapes single quotes", () => {
    expect(escAttr("it's")).toBe("it\\'s");
  });

  test("escapes double quotes", () => {
    expect(escAttr('say "hi"')).toBe('say \\"hi\\"');
  });

  test("escapes backslashes", () => {
    expect(escAttr("a\\b")).toBe("a\\\\b");
  });

  test("escapes angle brackets as hex", () => {
    expect(escAttr("<script>")).toBe("\\x3cscript\\x3e");
  });

  test("escapes ampersand as hex", () => {
    expect(escAttr("a&b")).toBe("a\\x26b");
  });

  test("returns empty string for null", () => {
    expect(escAttr(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(escAttr(undefined)).toBe("");
  });

  test("handles combined XSS payload", () => {
    expect(escAttr(`"><script>alert('xss')</script>`)).toBe(
      `\\"\\x3e\\x3cscript\\x3ealert(\\'xss\\')\\x3c/script\\x3e`
    );
  });

  test("passes through clean string unchanged", () => {
    expect(escAttr("hello")).toBe("hello");
  });

  test("backslash before quote is double-escaped", () => {
    expect(escAttr("\\'")).toBe("\\\\\\'");
  });
});

// ── esc tests ──

describe("esc", () => {
  test("escapes ampersand", () => {
    expect(esc("a&b")).toBe("a&amp;b");
  });

  test("escapes less-than", () => {
    expect(esc("a<b")).toBe("a&lt;b");
  });

  test("escapes greater-than", () => {
    expect(esc("a>b")).toBe("a&gt;b");
  });

  test("escapes double quotes", () => {
    expect(esc('a"b')).toBe("a&quot;b");
  });

  test("escapes single quotes", () => {
    expect(esc("a'b")).toBe("a&#39;b");
  });

  test("returns empty string for null", () => {
    expect(esc(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(esc(undefined)).toBe("");
  });

  test("handles HTML tag injection", () => {
    expect(esc("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  test("handles all entities together", () => {
    expect(esc(`<a href="x" onclick='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;"
    );
  });

  test("passes through clean string unchanged", () => {
    expect(esc("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(esc("")).toBe("");
  });

  test("coerces numbers to string", () => {
    expect(esc(42)).toBe("42");
  });
});
