#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const directory = path.resolve(process.argv[2] ?? "skills/codex-harness");
const content = await readFile(path.join(directory, "SKILL.md"), "utf8");
const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(content);
if (!match) throw new Error("Invalid or missing YAML frontmatter");

const allowed = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
const values = new Map();
for (const rawLine of match[1].split("\n")) {
  if (!rawLine.trim() || /^\s*#/u.test(rawLine)) continue;
  const field = /^([a-z][a-z0-9-]*):\s*(.*)$/u.exec(rawLine);
  if (!field) throw new Error("Unsupported frontmatter syntax: " + rawLine);
  const [, key, rawValue] = field;
  if (!allowed.has(key)) throw new Error("Unexpected SKILL.md frontmatter key: " + key);
  if (values.has(key)) throw new Error("Duplicate SKILL.md frontmatter key: " + key);
  values.set(key, rawValue.trim().replace(/^(["'])([\s\S]*)\1$/u, "$2"));
}

const name = values.get("name");
const description = values.get("description");
if (!name || !description) throw new Error("SKILL.md frontmatter requires non-empty name and description");
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) throw new Error("Skill name must be <=64 characters of hyphen-case");
if (description.length > 1_024 || /[<>]/u.test(description) || description.startsWith("[TODO:")) {
  throw new Error("Skill description is invalid");
}
if (/^[ \t]{0,3}\[TODO:[^\n]*\][ \t]*$/mu.test(content.slice(match[0].length))) {
  throw new Error("Skill instructions contain an unfinished TODO placeholder");
}
process.stdout.write("Skill is valid!\n");
