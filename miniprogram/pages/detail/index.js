const { wordView, copyCard, gate } = require('../../lib/present');
Page({
  data: { loading: true, error: '', entry: null, ready: false, tab: 'meaning', imagePath: '', imageBusy: false, word: '' },
  onLoad(options) {
    let word = options.word || ''; try { word = decodeURIComponent(word); } catch { /* A literal percent may already be decoded by WeChat. */ }
    this.setData({ word }); this.off = getApp().store.subscribe(() => this.render()); this.refresh();
  },
  onUnload() { if (this.off) this.off(); },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  render() {
    const { store, client } = getApp();
    const entry = store.detail(this.data.word);
    const data = store.view(store.cached('favorites') ? 'favorites' : 'today');
    const state = wordView(this.data.word, data, store.pending());
    const ready = entry?.aiCard?.cardStatus === 'ready' && entry.aiCard.projection !== 'list';
    this.setData({ demo: client.isDemo(), entry, ready, state, card: ready ? entry.aiCard : {}, missingLabel: entry?.aiCard?.cardStatus === 'pending' ? '词卡正在准备中' : '正式词卡尚未就绪' });
  },
  async refresh() {
    this.render(); this.setData({ loading: !getApp().store.detail(this.data.word), error: '' });
    try { await getApp().store.loadDetail(this.data.word); this.setData({ imagePath: '' }); } catch (e) { gate(this, e); }
    finally { this.setData({ loading: false }); this.render(); }
  },
  tab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },
  collect() {
    if (this.data.state.pending) { getApp().store.flush(); return; }
    if (this.data.state.favorite) { wx.switchTab({ url: '/pages/pool/index' }); return; }
    this.command('add');
  },
  command(action, status) { try { getApp().store.enqueue(this.data.word, action, status); } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); } },
  pending() {
    if (this.data.state.pending || this.data.state.status === 'published') return;
    this.command('status', this.data.state.status === 'pending' ? 'none' : 'pending');
  },
  remove() {
    if (this.data.state.pending || this.data.state.status === 'published') return;
    wx.showModal({ title: '移出选题池？', content: '仅移出团队收藏，词卡仍然保留。', confirmText: '移出', success: r => { if (r.confirm) this.command('remove'); } });
  },
  copy() {
    const text = copyCard(this.data.entry);
    if (text) wx.setClipboardData({ data: (this.data.demo ? '【交互示例，请勿直接发布】\n\n' : '') + text });
  },
  copyTitle(e) { const title = this.data.card.suggestedTitles?.[e.currentTarget.dataset.index]; if (title) wx.setClipboardData({ data: title }); },
  async image() {
    if (this.data.imageBusy) return;
    this.setData({ imageBusy: true });
    try { const path = await getApp().client.download(this.data.word); this.setData({ imagePath: path }); wx.previewImage({ urls: [path] }); }
    catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
    finally { this.setData({ imageBusy: false }); }
  },
  async saveImage() {
    if (this.data.imageBusy) return;
    this.setData({ imageBusy: true });
    try {
      const path = this.data.imagePath || await getApp().client.download(this.data.word);
      this.setData({ imagePath: path });
      await new Promise((resolve, reject) => { wx.saveImageToPhotosAlbum({ filePath: path, success: resolve, fail: reject }); });
      wx.showToast({ title: '参考图已保存' });
    } catch (e) {
      if (/auth deny|auth denied|authorize/i.test(e.errMsg || '')) wx.showModal({ title: '需要相册权限', content: '仅用于把你选择的参考图保存到手机。也可以继续查看，不保存。', confirmText: '去设置', success: r => { if (r.confirm) wx.openSetting({}); } });
      else wx.showToast({ title: e.message || '图片未保存，请稍后重试', icon: 'none' });
    }
    finally { this.setData({ imageBusy: false }); }
  }
});
