#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../src/db");
const { importQceJson } = require("../src/qceImporter");

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const pair = process.argv.find((item) => item.startsWith(prefix));
  if (pair) return pair.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function usage() {
  console.log(`Usage:
  node scripts/import-qce-json.js <export.json> --group-id 816998268 --start 2026-06-10 --end 2026-06-15

Options:
  --export-dir <dir>   QCE export directory. Defaults to the JSON file directory.
  --db <file>          SQLite file. Defaults to data/qq-monitor.sqlite.
  --media-dir <dir>    Local media directory. Defaults to data/media.`);
}

const input = process.argv[2];
if (!input || input.startsWith("--")) {
  usage();
  process.exit(1);
}

const rootDir = path.resolve(__dirname, "..");
const inputFile = path.resolve(input);
if (!fs.existsSync(inputFile)) {
  console.error(`Export JSON not found: ${inputFile}`);
  process.exit(1);
}

const dbFile = arg("db", "data/qq-monitor.sqlite");
const groupId = arg("group-id", "816998268");
const startDate = arg("start", "2026-06-10");
const endDate = arg("end", new Date().toISOString().slice(0, 10));
const dbPath = path.resolve(rootDir, dbFile);
if (fs.existsSync(dbPath)) {
  const backup = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(dbPath, backup);
  console.log(`backup = ${backup}`);
}

const db = openDatabase(rootDir, dbFile);
const result = importQceJson(db, inputFile, {
  groupId,
  startDate,
  endDate,
  exportDir: arg("export-dir", path.dirname(inputFile)),
  mediaDir: arg("media-dir", path.join(rootDir, "data", "media"))
});

console.log(JSON.stringify(result, null, 2));
