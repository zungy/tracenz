const { readFile, writeFile, rename } = require("node:fs/promises");

// Windows protects this file with the signed-in Windows user's credentials.
// Only upload credentials are persisted; login sessions remain in memory.
class CredentialVault {
  constructor(path, encryption) {
    this.path = path;
    this.encryption = encryption;
  }
  async read() {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error(
        "Windows credential protection is unavailable. Cloud uploads remain paused.",
      );
    try {
      return JSON.parse(
        this.encryption.decryptString(await readFile(this.path)),
      );
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error(
        "Saved upload credentials could not be read. Cloud uploads remain paused.",
      );
    }
  }
  async write(value) {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error(
        "Windows credential protection is unavailable. Cloud uploads remain paused.",
      );
    const temporary = this.path + ".tmp";
    await writeFile(
      temporary,
      this.encryption.encryptString(JSON.stringify(value)),
      { mode: 0o600 },
    );
    await rename(temporary, this.path);
  }
}

class CloudPairing {
  constructor({ cloud, local, vault }) {
    this.cloud = cloud;
    this.local = local;
    this.vault = vault;
    this.error = null;
  }
  async pause() {
    if (!this.local)
      throw new Error(
        "Local Fusion receiver is unavailable. Restart Trace to reconnect.",
      );
    const previous = await this.local.request("/api/forwarding");
    if (previous.enabled)
      await this.local.request("/api/forwarding", {
        method: "POST",
        body: { enabled: false },
      });
  }
  async login(credentials) {
    let syncError;
    try {
      await this.pause();
    } catch {
      syncError =
        "The local Fusion receiver could not be reached, so its upload pause could not be confirmed. Restart Trace before capturing more checkpoints.";
    }
    const data = await this.cloud.request("/api/auth/login", {
      method: "POST",
      body: credentials,
    });
    // Never enable another destination until the previous receiver is paused.
    if (!syncError) {
      try {
        await this.pair();
      } catch (error) {
        syncError = error.message;
      }
    }
    this.error = syncError || null;
    return { ...data, ...(syncError ? { syncError } : {}) };
  }
  async logout() {
    let syncError, warning;
    try {
      try {
        await this.pause();
      } catch {
        syncError =
          "The local Fusion receiver could not be reached, so its upload pause could not be confirmed. Quit Trace from the system tray before capturing more checkpoints.";
      }
      try {
        await this.cloud.request("/api/auth/logout", { method: "POST" });
      } catch {
        warning =
          "Signed out on this computer. Cloud session revocation could not be confirmed while offline.";
      }
    } finally {
      // Forget credentials and invalidate in-flight reads even if either service
      // is offline. The renderer must never keep the previous account open.
      this.cloud.connect(this.cloud.origin);
    }
    this.error = syncError || null;
    return { ok: true, warning, syncError };
  }
  async pair() {
    try {
      // Pause first, including on failures, so captures cannot reach a prior account.
      await this.pause();
      const user = await this.cloud.request("/api/auth/me");
      if (typeof user.id !== "string" || !/^[0-9a-f-]{36}$/i.test(user.id))
        throw new Error("Cloud account could not be verified.");
      const key = this.cloud.origin + "\n" + user.id;
      const records = await this.vault.read();
      let saved = records[key];
      const { tokens } = await this.cloud.request("/api/tokens");
      if (
        saved &&
        !tokens.some((token) => token.id === saved.id && !token.revoked_at)
      )
        throw new Error(
          "This computer's connection was revoked. Uploads are paused and queued checkpoints are still saved. Contact your Trace administrator to restore this connection.",
        );
      if (!saved) {
        saved = await this.cloud.request("/api/tokens", {
          method: "POST",
          body: { name: "Trace desktop — automatic Fusion uploads" },
        });
        if (
          typeof saved.token !== "string" ||
          !/^trc_[A-Za-z0-9_-]{43,64}$/.test(saved.token)
        )
          throw new Error("Cloud returned an invalid installation credential.");
        records[key] = { id: saved.id, token: saved.token };
        // Persist before enabling capture so a restart can resume the same queue.
        await this.vault.write(records);
      }
      await this.local.request("/api/forwarding", {
        method: "POST",
        body: { enabled: true, url: this.cloud.origin, token: saved.token },
      });
      this.error = null;
      return { ok: true };
    } catch (error) {
      this.error = error.message;
      throw error;
    }
  }
}
module.exports = { CredentialVault, CloudPairing };
