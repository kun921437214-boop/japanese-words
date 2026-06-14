(function () {
  // 默认使用当前访问域名，避免 Cloudflare Preview 环境写入 production 数据。
  // 如需指定其他同步 API，可在加载本文件前设置 window.KOTOBA_SYNC_API_URL。
  const explicitUrl = window.KOTOBA_SYNC_API_URL;
  const currentOrigin = window.location && window.location.origin;

  window.KOTOBA_SYNC_API_URL = explicitUrl || currentOrigin || '';
})();
