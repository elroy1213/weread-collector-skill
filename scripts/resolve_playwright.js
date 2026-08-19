function loadPlaywright() {
  const candidates = [
    process.env.WEREAD_PLAYWRIGHT_MODULE,
    "playwright",
  ].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "找不到 Playwright。请在 Skill 目录执行 npm install，或设置 WEREAD_PLAYWRIGHT_MODULE 指向已安装的 playwright。" +
      (lastError ? ` 最后错误：${lastError.message}` : ""),
  );
}

module.exports = { loadPlaywright };
