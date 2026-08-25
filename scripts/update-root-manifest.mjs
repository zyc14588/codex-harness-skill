#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { updateRootManifest } from "./root-manifest-lib.mjs";

function parseArgs(argv) {
  let root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root" || !argv[index + 1]) {
      throw new Error("Usage: update-root-manifest.mjs [--root REPOSITORY_TOP_LEVEL]");
    }
    root = path.resolve(argv[index + 1]);
    index += 1;
  }
  return root;
}

try {
  const result = await updateRootManifest(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`root Manifest update FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
