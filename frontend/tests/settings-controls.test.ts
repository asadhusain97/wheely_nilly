import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appHtml = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const settingsCss = readFileSync(new URL("../assets/css/settings.css", import.meta.url), "utf8");

test("settings keeps brokerage maintenance actions compact without changing their hooks", () => {
  const actions = appHtml.match(/<section class="data-refresh-settings"[\s\S]*?<\/section>/)?.[0] ?? "";

  assert.match(actions, /data-refresh-brokerage/);
  assert.match(actions, /data-reset-setup/);
  assert.match(actions, /data-restart-connection/);
  assert.match(actions, /Refresh data/);
  assert.match(actions, /Change account/);
  assert.match(actions, /Reconnect/);
  assert.doesNotMatch(actions, /is-primary/);
});

test("settings brokerage actions share a row and wrap for narrow screens", () => {
  assert.match(settingsCss, /\.data-refresh-settings\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(settingsCss, /@media \(max-width: 380px\)[\s\S]*?\.data-refresh-settings\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(settingsCss, /\.settings-data-action\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(settingsCss, /\.settings-data-action span\s*\{[\s\S]*?white-space:\s*normal/);
});
