// Session credentials stay in the main process. The renderer sees only user data.
class BackendClient {
  constructor(origin, fetcher = fetch) {
    this.origin = origin;
    this.fetch = fetcher;
    this.session = null;
    this.refreshing = null;
    this.epoch = 0;
  }
  connect(origin) {
    this.origin = origin;
    this.session = null;
    this.refreshing = null;
    this.epoch++;
  }
  async request(path, options = {}, retried = false) {
    const epoch = this.epoch,
      origin = this.origin,
      accessToken = this.session?.access_token;
    const response = await this.fetch(`${origin}${path}`, {
      method: options.method || "GET",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(120_000),
    });
    if (epoch !== this.epoch)
      throw new Error("Connection changed. Please try again.");
    const canRefresh = ![
      "/api/auth/login",
      "/api/auth/signup",
      "/api/auth/logout",
      "/api/auth/refresh",
    ].includes(path);
    if (
      response.status === 401 &&
      this.session?.refresh_token &&
      !retried &&
      canRefresh
    ) {
      // Another request may already have finished refreshing before this 401 arrived.
      if (accessToken !== this.session.access_token)
        return this.request(path, options, true);
      // Multiple image and timeline requests must not rotate the same refresh
      // token concurrently. Every request awaits the same refresh operation.
      if (!this.refreshing) {
        const refreshToken = this.session.refresh_token;
        const pending = this.request(
          "/api/auth/refresh",
          { method: "POST", body: { refresh_token: refreshToken } },
          true,
        );
        this.refreshing = pending;
        pending
          .finally(() => {
            if (this.refreshing === pending) this.refreshing = null;
          })
          .catch(() => {});
      }
      await this.refreshing;
      if (epoch !== this.epoch)
        throw new Error("Connection changed. Please try again.");
      return this.request(path, options, true);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(
        data.error || `Request failed (${response.status}).`,
      );
      error.status = response.status;
      throw error;
    }
    if (options.binary) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (epoch !== this.epoch)
        throw new Error("Connection changed. Please try again.");
      return bytes;
    }
    const data = await response.json();
    if (epoch !== this.epoch)
      throw new Error("Connection changed. Please try again.");
    if (data.session) {
      this.session = data.session;
      delete data.session;
    }
    if (path === "/api/auth/logout") {
      this.session = null;
      this.epoch++;
    }
    return data;
  }
}
module.exports = { BackendClient };
