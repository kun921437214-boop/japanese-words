async function listAllKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ cursor });
    keys.push(...page.keys.map(item => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

export async function copyKv(source, target, { reportListedKeys = false } = {}) {
  const keys = await listAllKeys(source);
  const copied = [];
  for (const key of keys) {
    const stored = await source.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!stored) continue;
    await target.put(key, stored.value, { metadata: stored.metadata || undefined });
    copied.push(key);
  }
  return reportListedKeys ? keys : copied;
}
