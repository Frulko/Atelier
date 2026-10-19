import { expect, test } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Ansi from "ansi-to-react";
import katex from "katex";

test("patched terminal linkifier preserves ANSI and safe link rendering", () => {
  const html=renderToStaticMarkup(React.createElement(Ansi,{linkify:true},"\u001b[31mFailed\u001b[0m https://example.test/docs"));
  expect(html).toContain("Failed");
  expect(html).toContain('href="https://example.test/docs"');
  const text=renderToStaticMarkup(React.createElement(Ansi,null,"<img src=x onerror=alert(1)>"));
  expect(text).not.toContain("<img");
});
test("patched math renderer keeps formulas and refuses untrusted HTML links", () => {
  expect(katex.renderToString("x^2 + y^2",{throwOnError:true})).toContain("katex");
  const html=katex.renderToString("\\href{javascript:alert(1)}{click}",{throwOnError:false,trust:false});
  expect(html).not.toContain('href="javascript:');
});
