const copy = value => JSON.parse(JSON.stringify(value));
const day = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function createStore(wx, client) {
  let member = '';
  let state = { views: {}, details: {}, queue: [] };
  let running = null;
  const listeners = new Set();
  const key = () => `kotoba_miniapp_cache_v1:${member}`;
  function identify() {
    const id = client.identity();
    if (id !== member) { member = id; state = id === 'demo' ? { views: {}, details: {}, queue: [] } : wx.getStorageSync(key()) || { views: {}, details: {}, queue: [] }; }
  }
  function save() {
    // Bounded cache: keep only the most recent 30 full cards.
    Object.keys(state.details).slice(0, -30).forEach(word => delete state.details[word]);
    if (member && member !== 'demo') wx.setStorageSync(key(), state);
    api.notify();
  }
  function mergeMembership(data) {
    if (!Array.isArray(data.words)) return;
    Object.values(state.views).forEach(view => { view.data.words = [...data.words]; view.data.statuses = { ...data.statuses }; });
  }
  const satisfies = (data, command) => command.action === 'remove' ? !data.words.includes(command.word)
    : data.words.includes(command.word) && (command.action !== 'status' || (data.statuses[command.word] || 'none') === command.status);
  const api = {
    online: true,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    notify() { listeners.forEach(callback => callback()); },
    reset() { member = ''; state = { views: {}, details: {}, queue: [] }; api.notify(); },
    pending() { identify(); return state.queue; },
    cached(scope) { identify(); return state.views[scope] || null; },
    view(scope) {
      identify();
      const data = copy(state.views[scope]?.data || { words: [], statuses: {}, candidatePool: {}, todaySnapshot: {}, publishedRecords: [] });
      state.queue.forEach(c => {
        if (c.action === 'remove') { data.words = data.words.filter(w => w !== c.word); delete data.statuses[c.word]; }
        else { if (!data.words.includes(c.word)) data.words.unshift(c.word); if (c.action === 'status') data.statuses[c.word] = c.status; }
      });
      return data;
    },
    async load(scope) {
      await client.ensureAuth(); identify();
      const id = member;
      const data = await client.request(`/workflow?scope=${scope}`);
      if (client.identity() !== id) throw new Error('登录身份已变更，请刷新');
      state.views[scope] = { data, savedAt: Date.now() };
      mergeMembership(data); save();
      await api.flush();
      return api.view(scope);
    },
    detail(word) { identify(); return state.details[word] || null; },
    async loadDetail(word) {
      await client.ensureAuth(); identify();
      const id = member;
      let result;
      try { result = await client.request(`/card?word=${encodeURIComponent(word)}`); }
      catch (e) {
        if (e.status === 404 && client.identity() === id) { delete state.details[word]; save(); }
        throw e;
      }
      if (client.identity() !== id) throw new Error('登录身份已变更，请刷新');
      if (!result.candidate) throw new Error('词卡暂时不可用');
      delete state.details[word]; state.details[word] = result.candidate; save();
      return result.candidate;
    },
    enqueue(word, action, status) {
      identify();
      if (!member) throw new Error('请先登录');
      if (state.queue.some(c => c.word === word)) return false;
      if (state.queue.length >= 50) throw new Error('待同步操作较多，请先恢复网络并同步');
      const command = { word, action, ...(status ? { status } : {}), operationId: `wx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`, error: '' };
      state.queue.push(command);
      try { save(); } catch (e) { state.queue.pop(); throw new Error('本机存储空间不足，请清理后重试'); }
      void api.flush(); return true;
    },
    flush() {
      identify();
      if (running) return running;
      if (!member || !api.online || !state.queue.length) return Promise.resolve();
      const id = member;
      running = (async () => {
        for (const command of [...state.queue]) {
          if (client.identity() !== id) break;
          try {
            // Read before replay: a previous timeout may already have committed.
            let confirmed = await client.request(`/confirmation?word=${encodeURIComponent(command.word)}`);
            if (!satisfies(confirmed, command)) {
              await client.request('/favorite', 'POST', command);
              confirmed = await client.request(`/confirmation?word=${encodeURIComponent(command.word)}`);
            }
            if (!satisfies(confirmed, command)) throw new Error('团队状态有变化，请重试同步');
            if (client.identity() !== id) break;
            mergeMembership(confirmed);
            state.queue = state.queue.filter(c => c.operationId !== command.operationId);
            save();
          } catch (e) {
            if (client.identity() !== id) break;
            command.error = e.message; save(); break;
          }
        }
      })().finally(() => { running = null; api.notify(); });
      return running;
    },
    async acceptRemote(operationId) {
      if (running) await running;
      identify();
      const command = state.queue.find(c => c.operationId === operationId);
      if (!command) return;
      const id = member;
      const confirmed = await client.request(`/confirmation?word=${encodeURIComponent(command.word)}`);
      if (client.identity() !== id) throw new Error('登录身份已变更，请刷新');
      mergeMembership(confirmed);
      state.queue = state.queue.filter(c => c.operationId !== operationId);
      save();
    },
    later(word) {
      identify(); const words = state.later?.date === day() ? state.later.words : [];
      state.later = { date: day(), words: [...new Set([...words, word])] }; save();
    },
    restoreLater() { identify(); state.later = { date: day(), words: [] }; save(); },
    laterWords() { identify(); return state.later?.date === day() ? state.later.words : []; }
  };
  return api;
}
module.exports = { createStore, day };
