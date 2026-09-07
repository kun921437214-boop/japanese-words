const { wordView, gate } = require('../../lib/present');
Page({
  data: { loading: true, error: '', query: '', filter: 'all', items: [], total: 0 },
  onLoad() { this.off = getApp().store.subscribe(() => this.render()); },
  onUnload() { if (this.off) this.off(); },
  onShow() { this.refresh(); },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  render() {
    const { store, client } = getApp();
    const data = store.view('favorites');
    const queue = store.pending();
    const query = this.data.query.trim().toLowerCase();
    const items = data.words.map(w => wordView(w, data, queue)).filter(i =>
      (this.data.filter === 'all' || (this.data.filter === 'saved' ? i.status === 'none' : i.status === this.data.filter)) &&
      (!query || [i.word, i.kana, i.meaning].join(' ').toLowerCase().includes(query)));
    this.setData({ demo: client.isDemo(), total: data.words.length, items, pendingCount: queue.length });
  },
  async refresh() {
    this.render(); this.setData({ loading: !getApp().store.cached('favorites'), error: '' });
    try { await getApp().store.load('favorites'); } catch (e) { gate(this, e); }
    finally { this.setData({ loading: false }); this.render(); }
  },
  search(e) { this.setData({ query: e.detail.value }); this.render(); },
  clearSearch() { this.setData({ query: '' }); this.render(); },
  filter(e) { this.setData({ filter: e.currentTarget.dataset.filter }); this.render(); },
  open(e) { wx.navigateTo({ url: `/pages/detail/index?word=${encodeURIComponent(e.currentTarget.dataset.word)}` }); },
  today() { wx.switchTab({ url: '/pages/today/index' }); },
  sync() { wx.switchTab({ url: '/pages/me/index' }); }
});
