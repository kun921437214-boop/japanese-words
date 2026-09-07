function error(message, code, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function createClient(wx, config) {
  const authKey = 'kotoba_miniapp_auth_v1';
  let auth = wx.getStorageSync(authKey) || null;
  let demo = false;
  let loginPromise = null;
  let demoData;
  const base = config.apiBaseUrl.replace(/\/$/, '');
  const persist = value => { auth = value; wx.setStorageSync(authKey, value); };
  function raw(path, method = 'GET', data, token) {
    return new Promise((resolve, reject) => { wx.request({
      url: base + path, method, data, timeout: 15000,
      header: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      success(response) {
        const body = response.data;
        if (response.statusCode < 200 || response.statusCode >= 300 || !body || typeof body !== 'object' || body.ok === false) {
          const e = body?.error || {};
          reject(error(e.message || '连接暂时不可用，请重试', e.code || 'HTTP_ERROR', { status: response.statusCode, memberId: e.memberId, retryable: e.retryable }));
        } else resolve(body);
      },
      fail: () => reject(error('网络没有连上，稍后可以重试', 'NETWORK_ERROR', { retryable: true }))
    }); });
  }
  function login(consented = false) {
    if (consented) wx.setStorageSync('kotoba_miniapp_consent_v1', true);
    if (!wx.getStorageSync('kotoba_miniapp_consent_v1')) return Promise.reject(error('请先登录团队', 'LOGIN_REQUIRED'));
    if (loginPromise) return loginPromise;
    loginPromise = new Promise((resolve, reject) => { wx.login({ success: resolve, fail: () => reject(error('微信登录暂时不可用', 'WECHAT_UNAVAILABLE')) }); })
      .then(result => raw('/login', 'POST', { code: result.code }))
      .then(result => { demo = false; persist(result); return result; })
      .catch(e => { if (e.status === 403) persist(null); throw e; })
      .finally(() => { loginPromise = null; });
    return loginPromise;
  }
  async function ensureAuth() {
    if (demo) return { memberId: 'demo' };
    if (!auth) throw error('请先登录团队', 'LOGIN_REQUIRED');
    if (auth.expiresAt - Date.now() < 60000) {
      const previous = auth.memberId;
      await login();
      if (auth.memberId !== previous) throw error('微信账号已变更，请重新进入团队', 'ACCOUNT_CHANGED');
    }
    return auth;
  }
  function sample(path, method, data) {
    const route = path.split('?')[0];
    const params = {};
    (path.split('?')[1] || '').split('&').forEach(pair => { const [k, v] = pair.split('='); if (k) params[k] = decodeURIComponent(v || ''); });
    if (route === '/favorite' && method === 'POST') {
      const { word, action, status } = data;
      if (action === 'remove') { demoData.words = demoData.words.filter(w => w !== word); delete demoData.statuses[word]; }
      else { if (!demoData.words.includes(word)) demoData.words.unshift(word); if (action === 'status') demoData.statuses[word] = status; }
      demoData.revision++;
    }
    if (route === '/card') return { ok: true, candidate: demoData.candidatePool[params.word] };
    if (route === '/me') return { ok: true, memberId: 'demo', expiresAt: 0 };
    return JSON.parse(JSON.stringify(demoData));
  }
  async function request(path, method = 'GET', data) {
    await ensureAuth();
    if (demo) return sample(path, method, data);
    const previous = auth.memberId;
    try { return await raw(path, method, data, auth.token); }
    catch (e) {
      if (e.status === 401) {
        await login();
        if (auth.memberId !== previous) throw error('微信账号已变更，请重新进入团队', 'ACCOUNT_CHANGED');
        return raw(path, method, data, auth.token);
      }
      if (e.status === 403) persist(null);
      throw e;
    }
  }
  async function download(word) {
    await ensureAuth();
    if (demo) throw error('示例没有配套参考图', 'IMAGE_NOT_READY');
    const attempt = () => new Promise((resolve, reject) => { wx.downloadFile({
      url: `${base}/image?word=${encodeURIComponent(word)}`, header: { Authorization: `Bearer ${auth.token}` }, timeout: 20000,
      success: r => r.statusCode === 200 ? resolve(r.tempFilePath) : reject(error('参考图暂时不可用', 'IMAGE_ERROR', { status: r.statusCode })),
      fail: () => reject(error('参考图下载失败，请重试', 'NETWORK_ERROR'))
    }); });
    const previous = auth.memberId;
    try { return await attempt(); } catch (e) {
      if (e.status !== 401) throw e;
      await login();
      if (auth.memberId !== previous) throw error('微信账号已变更，请重新进入团队', 'ACCOUNT_CHANGED');
      return attempt();
    }
  }
  return {
    login, request, download, ensureAuth,
    identity: () => demo ? 'demo' : auth?.memberId || '',
    isDemo: () => demo,
    startDemo() { demo = true; demoData = require('./fixture').workflow(); },
    async logout() { if (!demo && auth) await raw('/logout', 'POST', {}, auth.token); demo = false; persist(null); },
    endDemo() { demo = false; }
  };
}
module.exports = { createClient };
