// Single-value fixtures deliberately ignore keys, as the original API tests did.
export function createJsonKv(initialValue = null, { cloneReads = false } = {}) {
  let value = cloneReads ? structuredClone(initialValue) : initialValue;
  return {
    getCalls: 0,
    putCalls: 0,
    async get() {
      this.getCalls += 1;
      return cloneReads ? structuredClone(value) : value;
    },
    async put(_key, nextValue) {
      this.putCalls += 1;
      value = JSON.parse(nextValue);
    }
  };
}

// Draft/image tests need independent keys, raw or JSON reads, and TTL options.
export function createMemoryKv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    values,
    putCalls: 0,
    putOptions: [],
    async get(key, type) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, options = {}) {
      this.putCalls += 1;
      this.putOptions.push({ key, options });
      values.set(key, String(value));
    }
  };
}
