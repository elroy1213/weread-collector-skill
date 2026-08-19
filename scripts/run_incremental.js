#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TIME_ZONE = "Asia/Shanghai";
const RUNNER = path.join(__dirname, "weread-content-cdp.js");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value == null ? fallback : value.slice(prefix.length);
}

function args(name) {
  const prefix = `--${name}=`;
  return process.argv.filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length));
}

function positiveInteger(name, fallback) {
  const value = Number(arg(name, fallback));
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} 必须是非负整数`);
  return value;
}

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日期必须是 YYYY-MM-DD：${value}`);
  return value;
}

function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDate(value, days) {
  const date = new Date(`${dateOnly(value)}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeSegment(value) {
  return String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const current = readJson(file, {});
    if (processExists(current.pid)) {
      throw new Error(`已有增量任务运行中：pid=${current.pid}, startedAt=${current.startedAt || "unknown"}`);
    }
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
}

function loadRegistry(file) {
  const config = readJson(file, null);
  if (!config || !Array.isArray(config.sources) || !config.sources.length) {
    throw new Error(`来源配置无效：${file}`);
  }
  return config;
}

function outputResult(outputDir, source, from, to) {
  const slug = source.bookId.toLowerCase();
  const file = path.join(outputDir, safeSegment(source.name), `${slug}-content-${from}-to-${to}.json`);
  return { file, payload: readJson(file, null) };
}

function selectSources(sources) {
  const requested = args("source").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  const selected = requested.length ? sources.filter((source) => requested.includes(source.name)) : sources;
  const missing = requested.filter((name) => !selected.some((source) => source.name === name));
  if (missing.length) throw new Error(`找不到来源：${missing.join("、")}`);
  const limit = positiveInteger("limit", 0);
  return limit ? selected.slice(0, limit) : selected;
}

function main() {
  const projectRoot = path.resolve(process.env.WEREAD_PROJECT_ROOT || process.cwd());
  const configPath = path.resolve(arg("config", path.join(projectRoot, "outputs/sources.json")));
  const statePath = path.resolve(arg("state", path.join(projectRoot, "state/incremental.json")));
  const summaryPath = path.resolve(arg("summary", path.join(projectRoot, "state/last-run.json")));
  const outputDir = path.resolve(arg("output-dir", path.join(projectRoot, "outputs/weread-content")));
  const lockPath = `${statePath}.lock`;
  const to = dateOnly(arg("to", todayInShanghai()));
  const explicitFrom = arg("from", "");
  const overlapDays = positiveInteger("overlap-days", 2);
  const initialDays = Math.max(1, positiveInteger("initial-days", 7));
  const dryRun = process.argv.includes("--dry-run");
  const registry = loadRegistry(configPath);
  const selected = selectSources(registry.sources);
  const state = readJson(statePath, { version: 1, timeZone: TIME_ZONE, sources: {} });
  const plan = selected.map((source) => {
    const previous = state.sources[source.bookId] || {};
    const from = explicitFrom
      ? dateOnly(explicitFrom)
      : previous.lastIndexedTo
        ? shiftDate(previous.lastIndexedTo, -overlapDays)
        : shiftDate(to, -(initialDays - 1));
    if (from > to) throw new Error(`${source.name} 的起始日期晚于截止日期：${from} > ${to}`);
    return { source, from, to, previous };
  });

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, configPath, statePath, outputDir, plan: plan.map(({ source, from, to }) => ({ name: source.name, bookId: source.bookId, from, to })) }, null, 2));
    return;
  }

  acquireLock(lockPath);
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    for (const { source, from } of plan) {
      const sourceOutputDir = path.join(outputDir, safeSegment(source.name));
      const child = spawnSync(process.execPath, [
        RUNNER,
        `--config=${configPath}`,
        `--source=${source.name}`,
        `--from=${from}`,
        `--to=${to}`,
        `--output-dir=${sourceOutputDir}`,
      ], { stdio: "inherit", env: process.env });
      const exitCode = child.status == null ? 1 : child.status;
      const output = outputResult(outputDir, source, from, to);
      const completed = exitCode === 0 && output.payload;
      const result = {
        name: source.name,
        bookId: source.bookId,
        from,
        to,
        exitCode,
        status: completed ? (output.payload.failedCount ? "completed_with_article_failures" : "completed") : "fatal_error",
        articleCount: output.payload?.articleCount ?? null,
        successCount: output.payload?.successCount ?? null,
        failedCount: output.payload?.failedCount ?? null,
        outputFile: output.payload ? output.file : null,
      };
      results.push(result);
      state.sources[source.bookId] = {
        ...state.sources[source.bookId],
        name: source.name,
        lastRunAt: new Date().toISOString(),
        lastStatus: result.status,
        lastRange: { from, to },
        lastCounts: { articles: result.articleCount, success: result.successCount, failed: result.failedCount },
        ...(completed ? { lastIndexedTo: to } : {}),
      };
      state.updatedAt = new Date().toISOString();
      writeJsonAtomic(statePath, state);
    }
    const summary = {
      ok: results.every((result) => result.status !== "fatal_error"),
      startedAt,
      completedAt: new Date().toISOString(),
      rangeTo: to,
      sourceCount: results.length,
      completedCount: results.filter((result) => result.status !== "fatal_error").length,
      fatalCount: results.filter((result) => result.status === "fatal_error").length,
      articleFailureCount: results.reduce((sum, result) => sum + (result.failedCount || 0), 0),
      results,
    };
    writeJsonAtomic(summaryPath, summary);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error.stack || error) }, null, 2));
  process.exitCode = 1;
}
