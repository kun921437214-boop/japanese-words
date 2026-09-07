const { day } = require('./store');
function wordView(word, data, queue = []) {
  const entry = data.candidatePool?.[word] || {};
  const card = entry.aiCard || {};
  const pending = queue.find(c => c.word === word);
  const favorite = data.words?.includes(word);
  const status = data.statuses?.[word] || 'none';
  return { word, kana: entry.kana || '', meaning: entry.meaning || '点开查看词条', category: entry.category || '日语表达',
    summary: card.cardStatus === 'ready' ? card.summary || '' : '', favorite, status,
    pending: Boolean(pending), syncError: pending?.error || '',
    label: pending ? (pending.error ? '重试同步' : '待同步') : status === 'published' ? '已发布' : status === 'pending' ? '待发布' : favorite ? '已收进选题池' : '收进选题池',
    cardReady: card.cardStatus === 'ready', cardLabel: card.cardStatus === 'pending' ? '词卡准备中' : '基础词条' };
}
function copyCard(entry) {
  if (entry?.aiCard?.cardStatus !== 'ready' || entry.aiCard.projection === 'list') return '';
  const c = entry.aiCard;
  return [entry.kanji, entry.kana, c.summary, c.explanation, ...(c.examples || []).map(e => [e.jp, e.kana, e.romaji, e.cn, e.note].filter(Boolean).join('\n')),
    c.riskWarning ? `使用提醒：${c.riskWarning}` : ''].filter(Boolean).join('\n\n');
}
function gate(page, e) {
  if (['LOGIN_REQUIRED', 'MEMBER_REVOKED', 'MEMBER_NOT_APPROVED', 'ACCOUNT_CHANGED'].includes(e.code) || e.status === 403) {
    wx.navigateTo({ url: '/pages/login/index' }); return;
  }
  page.setData({ error: e.message || '加载失败，请重试' });
}
module.exports = { wordView, copyCard, gate, day };
