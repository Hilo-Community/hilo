// Preserve the original exports; macOS needs transparent space around the iOS-sized artwork.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/desktop-tauri");
const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
const exportsDir = join(app, "branding/Icon Exports");
const source = join(exportsDir, "Icon-iOS-Default-1024@1x.png");
const temporary = mkdtempSync(join(tmpdir(), "hilo-icons-"));

function generate(input, output, ...options) {
  const result = spawnSync(process.execPath, [cli, "icon", input, "--output", output, ...options], {
    cwd: app,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Icon generation failed (${result.signal ?? result.status})`);
}

// Avoid restarting the development app for icon files whose content did not change.
function syncFiles(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const input = join(from, entry.name);
    const output = join(to, entry.name);
    if (entry.isDirectory()) {
      syncFiles(input, output);
    } else {
      const content = readFileSync(input);
      if (!existsSync(output) || !readFileSync(output).equals(content))
        writeFileSync(output, content);
    }
  }
}

try {
  const platformIcons = join(temporary, "platform");
  const macIcons = join(temporary, "macos");
  const macSource = join(temporary, "macos.svg");
  const darkFavicon = join(temporary, "dark-favicon");
  generate(source, platformIcons);
  generate(join(exportsDir, "Icon-iOS-Dark-1024@1x.png"), darkFavicon, "--png", "64");

  // 824 px of artwork centered in a 1024 px canvas: 100 px of transparency on each side.
  // The exported rounded corners, colors and proportions remain part of the original image.
  writeFileSync(
    macSource,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><image x="100" y="100" width="824" height="824" href="data:image/png;base64,${readFileSync(source).toString("base64")}"/></svg>`,
  );
  generate(macSource, macIcons);
  copyFileSync(join(macIcons, "icon.icns"), join(platformIcons, "icon.icns"));
  syncFiles(platformIcons, join(app, "src-tauri/icons"));
  copyFileSync(join(platformIcons, "64x64.png"), join(app, "public/hilo.png"));
  copyFileSync(join(darkFavicon, "64x64.png"), join(app, "public/hilo-dark.png"));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
