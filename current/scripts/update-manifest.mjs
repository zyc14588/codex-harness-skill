#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const output = path.join(root, "MANIFEST_SHA256.txt");
const excludedDirectories = new Set([".git", "node_modules"]);
const excludedFilesAtAnyDepth = new Set([".DS_Store"]);

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function walk(directory, relative = "") {
  const files = [];
  for (const name of (await readdir(directory)).sort((a, b) => a.localeCompare(b))) {
    if (name.includes("\n") || name.includes("\r") || name.includes("\\")) throw new Error(`unsafe package path component: ${name}`);
    const childRelative = relative ? `${relative}/${name}` : name;
    if (childRelative === "MANIFEST_SHA256.txt" || excludedFilesAtAnyDepth.has(name)) continue;
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`package must not contain symlinks: ${childRelative}`);
    if (info.isDirectory()) {
      if (!excludedDirectories.has(name)) files.push(...await walk(target, childRelative));
    } else if (info.isFile()) files.push(childRelative);
    else throw new Error(`unsupported package entry: ${childRelative}`);
  }
  return files;
}

const files = await walk(root);
const lines = [];
for (const relative of files) lines.push(`${await digest(path.join(root, relative))}  ${relative}`);
await writeFile(output, `${lines.join("\n")}\n`, { mode: 0o644 });
process.stdout.write(`${files.length} files recorded in ${output}\n`);
