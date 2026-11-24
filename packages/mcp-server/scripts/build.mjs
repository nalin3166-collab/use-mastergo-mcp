import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const outFile = resolve(pkgRoot, "dist/index.js");

mkdirSync(dirname(outFile), { recursive: true });

await build({
  entryPoints: [resolve(pkgRoot, "src/index.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Keep published npm dependencies external; bundle private workspace @use-mastergo-mcp/protocol inline.
  external: [
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "sharp",
    "ws",
    "zod",
  ],
});

try {
  chmodSync(outFile, 0o755);
} catch {
  // Ignore chmod errors on Windows
}

console.log("[mcp-server] Built dist/index.js");
