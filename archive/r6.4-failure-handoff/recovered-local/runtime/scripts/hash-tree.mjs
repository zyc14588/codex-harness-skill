#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";

async function updateHashWithFile(hash, target) {
  for await (const chunk of createReadStream(target)) hash.update(chunk);
}

async function sha256PathTree(target) {
  const root = path.resolve(target);
  const hash = createHash("sha256");
  const visit = async (absolute, relative) => {
    const info = await lstat(absolute);
    const mode = (info.mode & 0o7777).toString(8);
    if (info.isDirectory()) {
      hash.update(`D\0${relative}\0${mode}\0`);
      const entries = (await readdir(absolute)).sort((a, b) => a.localeCompare(b));
      for (const entry of entries) {
        await visit(path.join(absolute, entry), relative ? `${relative}/${entry}` : entry);
      }
      return;
    }
    if (info.isSymbolicLink()) {
      hash.update(`L\0${relative}\0${mode}\0${await readlink(absolute)}\0`);
      return;
    }
    if (!info.isFile()) throw new Error(`unsupported file type in hashed artifact tree: ${absolute}`);
    hash.update(`F\0${relative}\0${mode}\0${info.size}\0`);
    await updateHashWithFile(hash, absolute);
    hash.update("\0");
  };
  await visit(root, "");
  return hash.digest("hex");
}

const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error("Usage: hash-tree.mjs PATH");
  process.exit(2);
}
process.stdout.write(`${await sha256PathTree(target)}\n`);
