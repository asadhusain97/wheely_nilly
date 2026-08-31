import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const stylesheets = [
  "app.css",
  "goal-selector.css",
  "home.css",
  "rolls.css",
  "screener.css",
  "settings.css",
];

const cssRoot = new URL("../assets/css/", import.meta.url);
const minimumFontSize = 12;

describe("interface font-size floor", () => {
  for (const stylesheet of stylesheets) {
    it(`keeps visible text in ${stylesheet} at 12px or larger`, () => {
      const css = readFileSync(new URL(stylesheet, cssRoot), "utf8");
      const numericSizes = [...css.matchAll(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g)];
      const clampMinimums = [...css.matchAll(/font-size:\s*clamp\(\s*([0-9]+(?:\.[0-9]+)?)px/g)];

      assert.ok(numericSizes.length + clampMinimums.length > 0, `${stylesheet} has no audited font sizes`);
      for (const match of [...numericSizes, ...clampMinimums]) {
        assert.ok(
          Number(match[1]) >= minimumFontSize,
          `${stylesheet} contains ${match[0]}, below the ${minimumFontSize}px floor`,
        );
      }
    });
  }
});
