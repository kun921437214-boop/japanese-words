// Credentials stay in the server environment. Never include URLs or response bodies in errors.
export async function sendOperationsNotification(env = {}, event = {}, options = {}) {
  const rawUrl = String(env.OPS_ALERT_WEBHOOK_URL || '').trim();
  if (!rawUrl) return { configured: false, sent: false, error: 'not_configured' };
  let url;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
  } catch {
    return { configured: true, sent: false, error: 'invalid_webhook_url' };
  }
  const feishu = url.hostname === 'open.feishu.cn'
    && /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname);
  const body = feishu ? { msg_type: 'text', content: { text: String(event.text || '').slice(0, 12000) } } : event;
  try {
    if (feishu && env.OPS_ALERT_SIGNING_SECRET) {
      const timestamp = String(Math.floor((options.nowMs ?? Date.now()) / 1000));
      const key = await globalThis.crypto.subtle.importKey('raw',
        new TextEncoder().encode(`${timestamp}\n${env.OPS_ALERT_SIGNING_SECRET}`),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = await globalThis.crypto.subtle.sign('HMAC', key, new Uint8Array());
      body.timestamp = timestamp;
      body.sign = globalThis.btoa(String.fromCharCode(...new Uint8Array(signature)));
    }
    const response = await (options.fetchImpl || fetch)(url.toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: globalThis.AbortSignal?.timeout?.(10000), redirect: 'error'
    });
    if (!response.ok) return { configured: true, sent: false, error: `webhook_http_${response.status}` };
    if (feishu) {
      const result = await response.json().catch(() => null);
      const code = result?.code ?? result?.StatusCode;
      if (code !== 0) return { configured: true, sent: false, error: 'feishu_rejected', remoteCode: Number.isInteger(code) ? code : null };
    }
    return { configured: true, sent: true, error: '' };
  } catch {
    return { configured: true, sent: false, error: 'webhook_transport_failed' };
  }
}
