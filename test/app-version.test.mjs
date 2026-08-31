import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APP_VERSION, LATEST_EXTENSION_VERSION } from "../lib/app-version.js";

test("reported app version matches the package release version", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(APP_VERSION, packageJson.version);
});

test("reported extension version matches the packaged extension sources", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")
  );
  const reliabilityCore = await readFile(new URL("../extension/reliability-core.js", import.meta.url), "utf8");
  const contentScript = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.equal(LATEST_EXTENSION_VERSION, manifest.version);
  assert.match(reliabilityCore, new RegExp(`EXTENSION_VERSION = ["']${escapeRegex(manifest.version)}["']`));
  assert.match(contentScript, new RegExp(`__youtubeAbTestsConnectorVersion = ["']${escapeRegex(manifest.version)}["']`));
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
