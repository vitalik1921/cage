// `npm version` runs this after it bumps package.json: the plugin carries the same version,
// and its hooks run `npx cage-ts@<that version>` when a project has no install of its own.
import fs from "node:fs";

const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const file = "plugin/.claude-plugin/plugin.json";
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.version = version;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
