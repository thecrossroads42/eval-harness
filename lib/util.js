// Small shared utilities: line-delimited record queue, bounded concurrency.

// A pull-based async queue. Producers push(); consumers await next(). next()
// resolves to null once close() is called and the backlog is drained.
export class RecordQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(x) {
    const w = this.waiters.shift();
    if (w) w(x);
    else this.items.push(x);
  }
  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()(null);
  }
  next() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }
  // Await the next record, or reject after timeoutMs.
  nextWithTimeout(timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`timed out after ${timeoutMs}ms waiting for next record`));
      }, timeoutMs);
      this.next().then((v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      });
    });
  }
}

// Run async tasks with a concurrency cap. `tasks` is an array of () => Promise.
export async function mapLimit(tasks, limit, onResult) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = await tasks[idx]();
      } catch (e) {
        results[idx] = { error: e?.message || String(e) };
      }
      if (onResult) onResult(results[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
