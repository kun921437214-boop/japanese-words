Page({
  data: { accepted: false, busy: false, error: '', memberId: '' },
  accept(e) { this.setData({ accepted: e.detail.value.includes('agree') }); },
  async login() {
    if (!this.data.accepted || this.data.busy) return;
    this.setData({ busy: true, error: '', memberId: '' });
    try { await getApp().client.login(true); getApp().store.reset(); wx.switchTab({ url: '/pages/today/index' }); }
    catch (e) { this.setData({ error: e.message, memberId: e.memberId || '' }); }
    finally { this.setData({ busy: false }); }
  },
  demo() { getApp().client.startDemo(); getApp().store.reset(); wx.switchTab({ url: '/pages/today/index' }); },
  copyId() { wx.setClipboardData({ data: this.data.memberId }); },
  privacy() { wx.showModal({ title: '团队使用与隐私说明', content: '微信登录用于识别你的团队成员身份，不获取手机号、头像或通讯录。服务端保存必要的成员标识和登录会话；你的收藏及选题状态会同步给团队。本机保留最近内容和待同步操作。保存参考图时才申请相册权限。退出会撤销当前会话；需要撤销团队权限或清理数据，可联系管理员。', showCancel: false }); }
});
