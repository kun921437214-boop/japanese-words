const dns = require('node:dns');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const originalLookup = dns.lookup.bind(dns);
const cache = new Map();

function normalizeOptions(options) {
  if (!options) return {};
  if (typeof options === 'number') return { family: options };
  return options;
}

function resolveFromEnv(hostname, family) {
  const rawMap = String(process.env.CODEX_DNS_FALLBACKS || '').trim();
  if (!rawMap) return null;
  const entries = rawMap.split(',').map(item => item.trim()).filter(Boolean);
  for (const entry of entries) {
    const [host, address] = entry.split('=').map(item => String(item || '').trim());
    if (host !== hostname) continue;
    const resolvedFamily = net.isIP(address);
    if (!resolvedFamily || (family && family !== resolvedFamily)) return null;
    return { address, family: resolvedFamily };
  }
  return null;
}

function resolveViaCurl(hostname, family) {
  const cacheKey = `${hostname}:${family || 0}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const envResolved = resolveFromEnv(hostname, family);
  if (envResolved) {
    cache.set(cacheKey, envResolved);
    return envResolved;
  }

  const path = hostname === 'api.cloudflare.com'
    ? '/client/v4/user/tokens/verify'
    : '/';
  const url = `https://${hostname}${path}`;
  let rawIp = '';
  for (let attempt = 0; attempt < 3 && !rawIp; attempt += 1) {
    try {
      rawIp = execFileSync('curl', [
        '-L',
        '-sS',
        '--connect-timeout',
        '5',
        '--max-time',
        '8',
        '-o',
        '/dev/null',
        '-w',
        '%{remote_ip}',
        url
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: ''
        }
      }).trim();
    } catch (error) {
      rawIp = '';
    }
  }

  const resolvedFamily = net.isIP(rawIp);
  if (!resolvedFamily || (family && family !== resolvedFamily)) {
    throw new Error(`Unable to resolve ${hostname} via curl`);
  }

  const value = { address: rawIp, family: resolvedFamily };
  cache.set(cacheKey, value);
  return value;
}

dns.lookup = function patchedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = normalizeOptions(typeof options === 'function' ? {} : options);

  if (net.isIP(hostname)) {
    const family = net.isIP(hostname);
    if (opts.all) return cb(null, [{ address: hostname, family }]);
    return cb(null, hostname, family);
  }

  return originalLookup(hostname, options, (error, address, family) => {
    if (!error) return cb(null, address, family);
    if (!['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return cb(error);
    try {
      const resolved = resolveViaCurl(hostname, opts.family);
      if (opts.all) return cb(null, [resolved]);
      return cb(null, resolved.address, resolved.family);
    } catch (fallbackError) {
      return cb(error);
    }
  });
};
