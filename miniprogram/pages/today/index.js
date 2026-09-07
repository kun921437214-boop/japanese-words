const { wordView, gate, day } = require('../../lib/present');
Page({
  data: { loading: true, error: '', items: [], pendingCount: 0, laterCount: 0 },
  onLoad() { this.off = getApp().store.subscribe(() => this.render()); },
  onUnload() { if (this.off) this.off(); },
  onShow() { this.refresh(); },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  render() {
    const { store, client } = getApp();
    const data = store.view('today');
    const later = store.laterWords();
    const snapshot = data.todaySnapshot || {};
    const queue = store.pending();
    const date = snapshot.dateKey || '';
    const cache = store.cached('today');
    this.setData({
      demo: client.isDemo(), offline: !store.online, pendingCount: queue.length,
      items: (snapshot.words || []).filter(w => !later.includes(w)).map(w => wordView(w, data, queue)),
      total: (snapshot.words || []).length, laterCount: (snapshot.words || []).filter(w => later.includes(w)).length,
      dateLabel: date ? date.replace(/-/g, '.') : day().replace(/-/g, '.'), stale: Boolean(date && date !== day()),
      cachedAt: cache ? new Date(cache.savedAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''
    });
  },
  async refresh() {
    this.render(); this.setData({ loading: !getApp().store.cached('today'), error: '' });
    try { await getApp().store.load('today'); } catch (e) { gate(this, e); }
    finally { this.setData({ loading: false }); this.render(); }
  },
  open(e) { wx.navigateTo({ url: `/pages/detail/index?word=${encodeURIComponent(e.currentTarget.dataset.word)}` }); },
  collect(e) {
    const item = this.data.items.find(i => i.word === e.currentTarget.dataset.word);
    if (!item || item.status === 'published') return;
    if (item.pending) { getApp().store.flush(); return; }
    if (item.favorite) { wx.switchTab({ url: '/pages/pool/index' }); return; }
    try { getApp().store.enqueue(item.word, 'add'); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
  },
  later(e) {
    getApp().store.later(e.currentTarget.dataset.word);
    wx.showToast({ title: '已放到稍后看，可在页底恢复', icon: 'none' });
  },
  restore() { getApp().store.restoreLater(); },
  sync() { wx.switchTab({ url: '/pages/me/index' }); }
});
