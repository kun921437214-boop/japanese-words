Page({
  data: { queue: [], busy: false, error: '', memberId: '' },
  onLoad() { this.off = getApp().store.subscribe(() => this.render()); },
  onUnload() { if (this.off) this.off(); },
  onShow() { this.render(); },
  onPullDownRefresh() { this.retry().finally(() => wx.stopPullDownRefresh()); },
  render() {
    const { client, store } = getApp();
    this.setData({ demo: client.isDemo(), memberId: client.identity(), queue: store.pending().map(c => ({ ...c, actionLabel: c.action === 'remove' ? '移出选题池' : c.action === 'status' ? (c.status === 'pending' ? '标记待发布' : '取消待发布') : '加入选题池' })), offline: !store.online });
  },
  async retry() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await getApp().store.flush(); } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ busy: false }); this.render(); }
  },
  acceptRemote(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '以团队最新状态为准？', content: '重新读取服务器，再清除这条本机待同步意图。这不会撤销已经保存到团队的操作。', confirmText: '读取并清除', success: async r => {
      if (!r.confirm) return;
      try { await getApp().store.acceptRemote(id); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
    } });
  },
  login() { getApp().client.endDemo(); getApp().store.reset(); wx.navigateTo({ url: '/pages/login/index' }); },
  async logout() {
    if (this.data.busy) return;
    if (getApp().store.pending().length) { wx.showModal({ title: '还有操作待同步', content: '先完成同步再退出，可以避免遗漏刚刚选择的词。', showCancel: false }); return; }
    this.setData({ busy: true });
    try { await getApp().client.logout(); getApp().store.reset(); wx.navigateTo({ url: '/pages/login/index' }); }
    catch (e) { this.setData({ error: '退出未完成，请联网后重试' }); }
    finally { this.setData({ busy: false }); }
  },
  desktop() { wx.setClipboardData({ data: 'https://bijinihaitan.cn' }); },
  help() { wx.showModal({ title: '手机端怎么用', content: '今日推荐用于发现词；收进选题池表示你可能会做这个选题；待发布表示准备制作或发布，不会自动发帖。稍后看仅影响本机当天列表，页底可以恢复。批量管理、实际发布记录和数据复盘仍在电脑网页端。', showCancel: false }); },
  copyMember() { if (!this.data.demo && this.data.memberId) wx.setClipboardData({ data: this.data.memberId }); }
});
