import backendURLs from "../desktop/backend-url.cjs";
import { hash, HttpError } from "./domain.js";

// Queue records and capture are committed in the same SQLite transaction.
// Credentials never leave this module except in the outbound Authorization header.
export class Forwarding {
  constructor(store, { fetcher = fetch, allowHttp = false } = {}) {
    this.store = store;
    this.db = store.db;
    this.fetch = fetcher;
    this.allowHttp = allowHttp; // Test harness only. Production requires HTTPS.
    this.running = null;
  }
  config() {
    return this.db.prepare("SELECT * FROM forwarding_config WHERE id=1").get();
  }
  status() {
    const c = this.config();
    const counts = c
      ? this.db
          .prepare(
            `SELECT j.state,COUNT(*) AS count FROM forwarding_jobs j JOIN events e ON e.id=j.event_id WHERE destination=? AND e.deleted_at IS NULL GROUP BY j.state`,
          )
          .all(c.destination)
      : [];
    const last = c
      ? this.db
          .prepare(
            `SELECT error FROM forwarding_jobs WHERE destination=? AND error IS NOT NULL ORDER BY available_at DESC LIMIT 1`,
          )
          .get(c.destination)
      : null;
    return {
      enabled: !!c?.enabled,
      url: c?.url || "",
      hasToken: !!c?.token,
      counts: Object.fromEntries(counts.map((r) => [r.state, r.count])),
      error: last?.error || null,
    };
  }
  save(input) {
    if (!input || typeof input.enabled !== "boolean")
      throw new HttpError(400, "Choose whether forwarding is enabled.");
    const old = this.config();
    if (!input.enabled && old) {
      this.db
        .prepare("UPDATE forwarding_config SET enabled=0 WHERE id=1")
        .run();
      return this.status();
    }
    let endpoint;
    try {
      endpoint = backendURLs.backendUrl(input.url, {
        allowLocal: this.allowHttp,
      });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const token = input.token || (old?.url === endpoint ? old.token : "");
    if (typeof token !== "string" || !/^trc_[A-Za-z0-9_-]{43,64}$/.test(token))
      throw new HttpError(
        400,
        "Enter a Trace installation token created in the hosted workspace.",
      );
    const destination = hash(endpoint + "\n" + token);
    this.db
      .prepare(
        `INSERT INTO forwarding_config VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,token=excluded.token,enabled=excluded.enabled,destination=excluded.destination`,
      )
      .run(endpoint, token, Number(input.enabled), destination);
    return this.status();
  }
  backfill() {
    const c = this.config();
    if (!c?.enabled) throw new HttpError(409, "Enable forwarding first.");
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO forwarding_jobs(event_id,destination) SELECT id,? FROM events WHERE deleted_at IS NULL`,
      )
      .run(c.destination).changes;
  }
  retry() {
    const c = this.config();
    if (c)
      this.db
        .prepare(
          `UPDATE forwarding_jobs SET state='pending',available_at=0,error=NULL WHERE destination=? AND state IN ('blocked','pending')`,
        )
        .run(c.destination);
  }
  async tick() {
    if (this.running) return this.running;
    this.running = this.deliver().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async deliver() {
    const c = this.config();
    if (!c?.enabled) return;
    const job = this.db
      .prepare(
        `SELECT j.*,e.owner_id FROM forwarding_jobs j JOIN events e ON e.id=j.event_id WHERE destination=? AND state='pending' AND j.available_at<=? AND e.deleted_at IS NULL ORDER BY e.received_at LIMIT 1`,
      )
      .get(c.destination, Date.now());
    if (!job) return;
    // A process exit during fetch leaves a pending row. Cloud ingestion deduplicates retries.
    try {
      const row = await this.store.get(job.owner_id, job.event_id);
      if (!row) return;
      const image = await this.store.image(row);
      const response = await this.fetch(c.url + "/api/events", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.token}`,
        },
        body: JSON.stringify({
          event: row.raw_event,
          viewport: {
            filename: "viewport.png",
            contentType: "image/png",
            base64: image.toString("base64"),
          },
        }),
      });
      if (!response.ok) {
        const blocked = [400, 401, 403, 404, 409, 413, 415, 422].includes(
          response.status,
        );
        this.fail(
          job,
          blocked,
          `Cloud upload returned HTTP ${response.status}. ${blocked ? "Check your destination and token, then retry." : "Trace will retry automatically."}`,
        );
        return;
      }
      const receipt = await response.json();
      if (
        receipt.ok !== true ||
        typeof receipt.eventId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(receipt.eventId)
      )
        throw new Error("Invalid receipt");
      this.db
        .prepare(
          `UPDATE forwarding_jobs SET state='uploaded',cloud_id=?,error=NULL WHERE event_id=? AND destination=?`,
        )
        .run(receipt.eventId, job.event_id, job.destination);
    } catch {
      this.fail(
        job,
        false,
        "Cloud unreachable or upload receipt invalid. Trace will retry automatically.",
      );
    }
  }
  fail(job, blocked, message) {
    this.db
      .prepare(
        `UPDATE forwarding_jobs SET state=?,attempts=attempts+1,available_at=?,error=? WHERE event_id=? AND destination=?`,
      )
      .run(
        blocked ? "blocked" : "pending",
        Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(job.attempts, 6)),
        message,
        job.event_id,
        job.destination,
      );
  }
  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 2500);
  }
  async stop() {
    clearInterval(this.timer);
    await this.running;
  }
}
