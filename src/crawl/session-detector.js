/** 会话提示缓存仅供 UI；开始与继续的握手不使用此缓存。 */
export const SESSION_TTL_MS = 5 * 60_000;

export class SessionDetector {
  constructor({ probe, read = async () => null, write = async () => {}, now = Date.now, ttlMs = SESSION_TTL_MS }) {
    this._probe = probe;
    this._read = read;
    this._write = write;
    this._now = now;
    this._ttl = ttlMs;
    this._cached = null;
    this._flight = null;
    this._generation = 0;
    this._invalidated = false;
  }

  invalidate() {
    this._cached = null;
    this._generation++;
    this._invalidated = true;
    void this._write(null).catch(() => {});
  }

  detect({ force = false } = {}) {
    if (force) this.invalidate();
    if (this._flight) return this._flight;
    const generation = this._generation;
    this._flight = (async () => {
      const cached = this._cached ?? (this._invalidated ? null : await this._read());
      if (!force && cached?.at <= this._now() && this._now() - cached.at < this._ttl) {
        this._cached = cached;
        return cached.result;
      }
      const result = await this._probe();
      if (generation === this._generation) {
        this._cached = { at: this._now(), result };
        this._invalidated = false;
        await this._write(this._cached);
      }
      return result;
    })().finally(() => { this._flight = null; });
    return this._flight;
  }
}
