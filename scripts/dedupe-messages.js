#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../src/db");
const { dedupeMessages } = require("../src/dedupeMessages");

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const pair = process.argv.find((item) => item.startsWith(prefix));
  if (pair) return pair.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const rootDir = path.resolve(__dirname, "..");
const dbFile = arg("db", "data/qq-monitor.sqlite");
const dbPath = path.resolve(rootDir, dbFile);
const apply = process.argv.includes("--apply");
const backupPath = `${dbPath}.dedupe-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const db = openDatabase(rootDir, dbFile);
const result = dedupeMessages(db, {
  dbPath,
  backupPath,
  apply,
  groupId: arg("group-id", "816998268"),
  startDate: arg("start", "2026-06-10"),
  endDate: arg("end", new Date().toISOString().slice(0, 10))
});

console.log(JSON.stringify({
  ...result,
  backup: apply && fs.existsSync(backupPath) ? backupPath : ""
}, null, 2));

if (!apply) {
  console.log("preview only: add --apply to delete duplicates after reviewing duplicateCount");
}
