#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(process.env.WEREAD_PROJECT_ROOT || process.cwd());
const DEFAULT_CONFIG = path.join(PROJECT_ROOT, "outputs/sources.json");
const CORE_RUNNER = path.join(__dirname, "collector_core.js");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value == null ? fallback : value.slice(prefix.length);
}

function loadConfig(file) {
  const configPath = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(config.sources) || !config.sources.length) throw new Error("sources.json 没有可用来源");
  return { configPath, config };
}

function resolveSource(sources) {
  const name = arg("source", "");
  const bookId = arg("book-id", "");
  const matches = sources.filter((source) => (name && source.name === name) || (bookId && source.bookId === bookId));
  if (matches.length !== 1) {
    const selector = name ? `source=${name}` : `book-id=${bookId}`;
    throw new Error(`${selector} 未唯一匹配来源（匹配数：${matches.length}）。可用来源：${sources.map((source) => source.name).join("、")}`);
  }
  return matches[0];
}

function printSource(source, configPath) {
  console.log(JSON.stringify({ ok: true, configPath, source }, null, 2));
}

async function checkCdp() {
  const url = process.env.WEREAD_CDP_URL || "http://127.0.0.1:9222";
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2500) });
    const payload = await response.json();
    return { ok: response.ok, url, browser: payload.Browser || null };
  } catch (error) {
    return { ok: false, url, error: String(error) };
  }
}

async function main() {
  const { configPath, config } = loadConfig(arg("config", DEFAULT_CONFIG));
  if (process.argv.includes("--list")) {
    console.log(JSON.stringify({ ok: true, configPath, sourceCount: config.sources.length, sources: config.sources.map(({ name, bookId, latestUpdateAt, latestUpdateStatus }) => ({ name, bookId, latestUpdateAt, latestUpdateStatus })) }, null, 2));
    return;
  }
  const source = resolveSource(config.sources);
  if (process.argv.includes("--dry-run")) {
    printSource(source, configPath);
    return;
  }
  if (process.argv.includes("--smoke-test")) {
    const cdp = await checkCdp();
    console.log(JSON.stringify({ ok: cdp.ok, configPath, source: { name: source.name, bookId: source.bookId }, cdp }, null, 2));
    process.exitCode = cdp.ok ? 0 : 2;
    return;
  }

  const passthrough = process.argv.slice(2).filter((item) => !item.startsWith("--config=") && !item.startsWith("--source=") && !item.startsWith("--book-id=") && !["--dry-run", "--smoke-test", "--list"].includes(item));
  const outputRoot = path.resolve(arg("output-dir", path.join(PROJECT_ROOT, "outputs/weread-content", source.name)));
  const child = spawnSync(process.execPath, [CORE_RUNNER, ...passthrough], {
    stdio: "inherit",
    env: { ...process.env, WEREAD_BOOK_ID: source.bookId, WEREAD_SOURCE_NAME: source.name, WEREAD_OUTPUT_DIR: outputRoot },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status == null ? 1 : child.status;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.stack || error) }, null, 2));
  process.exitCode = 1;
});
