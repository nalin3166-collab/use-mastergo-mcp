import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const distDir = resolve(pkgRoot, "dist");
const isWatch = process.argv.includes("--watch");

function copyStaticAssets() {
  mkdirSync(distDir, { recursive: true });
  copyFileSync(resolve(pkgRoot, "manifest.json"), resolve(distDir, "manifest.json"));
  copyFileSync(resolve(pkgRoot, "src/ui.html"), resolve(distDir, "ui.html"));
}

const buildOptions = {
  entryPoints: [resolve(pkgRoot, "src/main.ts")],
  outfile: resolve(distDir, "main.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: false,
  logLevel: "info",
};

copyStaticAssets();

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log("[mg-plugin] Watching for changes...");
} else {
  await build(buildOptions);
  console.log("[mg-plugin] Built dist/{manifest.json,main.js,ui.html}");
}
