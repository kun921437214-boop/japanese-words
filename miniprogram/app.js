const { createClient } = require('./lib/client');
const { createStore } = require('./lib/store');
const config = require('./config');
App({
  onLaunch() {
    this.client = createClient(wx, config);
    this.store = createStore(wx, this.client);
    wx.getNetworkType({ success: ({ networkType }) => {
      this.store.online = networkType !== 'none';
      this.store.notify();
    } });
    wx.onNetworkStatusChange(({ isConnected }) => {
      this.store.online = isConnected;
      this.store.notify();
      if (isConnected && this.client.identity()) this.store.flush().catch(() => {});
    });
    const manager = wx.getUpdateManager();
    manager.onUpdateReady(() => {
      if (this.store.pending().length) return;
      wx.showModal({ title: '新版本已就绪', content: '重启小程序即可更新。', success: r => { if (r.confirm) manager.applyUpdate(); } });
    });
  }
});
