#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value == null ? fallback : value.slice(prefix.length);
}

const configPath = path.resolve(arg("config", path.join(process.cwd(), "outputs/sources.json")));
const errors = [];
let config;

try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(JSON.stringify({ ok: false, configPath, error: String(error) }, null, 2));
  process.exit(1);
}

if (!Array.isArray(config.sources) || config.sources.length === 0) errors.push("sources 必须是非空数组");
const ids = new Set();
for (const [index, source] of (config.sources || []).entries()) {
  const label = `sources[${index}]`;
  if (!source.name) errors.push(`${label}.name 缺失`);
  if (!/^MP_WXS_\d+$/.test(String(source.bookId || ""))) errors.push(`${label}.bookId 无效：${source.bookId || ""}`);
  if (!/^https:\/\/weread\.qq\.com\/web\/mp\/reader\//.test(String(source.readerUrl || ""))) errors.push(`${label}.readerUrl 无效`);
  if (ids.has(source.bookId)) errors.push(`重复 bookId：${source.bookId}`);
  ids.add(source.bookId);
  if (!["verified", "pending_reader_refresh", "unknown"].includes(source.latestUpdateStatus)) {
    errors.push(`${label}.latestUpdateStatus 无效：${source.latestUpdateStatus || ""}`);
  }
}

const result = {
  ok: errors.length === 0,
  configPath,
  sourceCount: config.sources?.length || 0,
  uniqueBookIdCount: ids.size,
  verifiedUpdateCount: config.sources?.filter((source) => source.latestUpdateStatus === "verified").length || 0,
  pendingUpdateCount: config.sources?.filter((source) => source.latestUpdateStatus === "pending_reader_refresh").length || 0,
  errors,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);
