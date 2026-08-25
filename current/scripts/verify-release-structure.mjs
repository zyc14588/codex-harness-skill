#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { auditActiveSourceStructure, auditArchiveManifestEntries, auditPackageStructure } from "./release-structure.mjs";

function parseArgs(argv) {
  if (argv.length !== 2 || !["--active-source", "--package-staging", "--archive-manifest"].includes(argv[0])) {
    throw new Error("Usage: verify-release-structure.mjs (--active-source ROOT|--package-staging ROOT|--archive-manifest JSON)");
  }
  return { mode: argv[0], target: path.resolve(argv[1]) };
}

try {
  const options = parseArgs(process.argv.slice(2));
  let result;
  if (options.mode === "--active-source") result = await auditActiveSourceStructure(options.target);
  else if (options.mode === "--package-staging") result = await auditPackageStructure(options.target);
  else {
    const manifest = JSON.parse(await readFile(options.target, "utf8"));
    result = auditArchiveManifestEntries(manifest.entries);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`release structure gate FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
