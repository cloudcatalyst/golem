// Sync this extension's runtime files into the installed VS Code copy.
//
// The extension has no build step (plain JS), and VS Code loads an INSTALLED
// COPY under ~/.vscode/extensions — so editing the repo does nothing until the
// files are synced there. This script does that copy; then run VS Code's
// "Developer: Reload Window" to apply. Cross-platform (node:os/path).
//
// If the extension isn't installed yet, install it once (package a VSIX with
// `vsce package` and `code --install-extension`, or run the dev host), then use
// this for fast iteration.

import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = createRequire(import.meta.url)("./package.json");
const id = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
const dest = join(homedir(), ".vscode", "extensions", id);

if (!existsSync(dest)) {
  console.error(`Golem extension not installed at:\n  ${dest}\n`);
  console.error("Install it once (VSIX or dev host), then re-run `npm run deploy:local`.");
  process.exit(1);
}

const files = ["extension.js", "render.js", "package.json", "README.md"];
for (const f of files) {
  const src = join(here, f);
  if (existsSync(src)) cpSync(src, join(dest, f));
}
if (existsSync(join(here, "media"))) {
  cpSync(join(here, "media"), join(dest, "media"), { recursive: true });
}

console.log(`Synced extension → ${dest}`);
console.log("Now run 'Developer: Reload Window' in VS Code (Ctrl+Shift+P) to apply.");
