import { open, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function alertEnvironmentText(webhook, signingSecret = '') {
  if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(webhook)) {
    throw new Error('INVALID_FEISHU_WEBHOOK');
  }
  if (signingSecret && !/^[a-zA-Z0-9_-]{8,256}$/.test(signingSecret)) throw new Error('INVALID_SIGNING_SECRET');
  return `OPS_ALERT_WEBHOOK_URL=${webhook}\n${signingSecret ? `OPS_ALERT_SIGNING_SECRET=${signingSecret}\n` : ''}`;
}

export async function saveAlertEnvironment(target, webhook, signingSecret = '', options = {}) {
  const text = alertEnvironmentText(webhook, signingSecret);
  const existing = await stat(target).catch(error => {
    if (error.code !== 'ENOENT') throw new Error('CONFIG_PATH_UNAVAILABLE');
    return null;
  });
  if (existing && !options.replace) throw new Error('CONFIG_ALREADY_EXISTS');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

// Secret input is terminal stdin, never a command argument or a readline/history entry.
export async function hiddenInput(prompt) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  const input = process.stdin;
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const finish = (error = null) => {
        input.off('data', onData);
        input.off('end', onEnd);
        error ? reject(error) : resolve(value);
      };
      const onEnd = () => finish(new Error('INPUT_ABORTED'));
      const onData = bytes => {
        for (const character of bytes.toString('utf8')) {
          if (character === '\u0003' || character === '\u0004') return finish(new Error('INPUT_ABORTED'));
          if (character === '\r' || character === '\n') return finish();
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else if (character.charCodeAt(0) >= 32 && character.charCodeAt(0) < 127) value += character;
          else return finish(new Error('INVALID_INPUT'));
          if (value.length > 1000) return finish(new Error('INPUT_TOO_LONG'));
        }
      };
      input.on('data', onData);
      input.on('end', onEnd);
      // Disable echo and register the reader before inviting an immediate paste.
      process.stderr.write(prompt);
      input.resume();
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    process.stderr.write('\n');
  }
}

async function main() {
  if (process.getuid?.() !== 0) throw new Error('ROOT_REQUIRED');
  const args = process.argv.slice(2);
  if (args.some(arg => !['--signing', '--replace'].includes(arg))) throw new Error('INVALID_ARGUMENT');
  const webhook = await hiddenInput('请本人粘贴飞书机器人 Webhook，然后按回车（输入不显示）：');
  const secret = args.includes('--signing') ? await hiddenInput('请本人粘贴签名密钥，然后按回车（输入不显示）：') : '';
  await saveAlertEnvironment('/etc/japanese-words-ops-alert.env', webhook, secret, { replace: args.includes('--replace') });
  console.log('通知配置已保存（root:root 0600）。尚未重启服务或发送消息。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const allowed = ['ROOT_REQUIRED', 'INVALID_ARGUMENT', 'INVALID_FEISHU_WEBHOOK', 'INVALID_SIGNING_SECRET', 'INTERACTIVE_TERMINAL_REQUIRED', 'CONFIG_ALREADY_EXISTS', 'INPUT_ABORTED', 'INVALID_INPUT', 'INPUT_TOO_LONG'];
    console.error(allowed.includes(error?.message) ? error.message : 'CONFIG_SAVE_FAILED');
    process.exitCode = 1;
  });
}
