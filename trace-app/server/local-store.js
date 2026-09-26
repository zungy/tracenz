import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "./domain.js";

const jsonFields = ["raw_event", "ai", "image_dimensions"];
function hydrate(row) {
  if (!row) return null;
  for (const field of jsonFields)
    if (typeof row[field] === "string") row[field] = JSON.parse(row[field]);
  return row;
}
export class LocalStore {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "trace.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, source_key TEXT NOT NULL,
        name TEXT NOT NULL, UNIQUE(owner_id, source, source_key));
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id),
        dedupe_key TEXT NOT NULL, fingerprint TEXT NOT NULL, raw_event TEXT NOT NULL,
        captured_at TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        ai TEXT, ai_provider TEXT, ai_model TEXT, prompt_version TEXT, error TEXT,
        image BLOB, image_bytes INTEGER NOT NULL, image_dimensions TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
        UNIQUE(owner_id, dedupe_key));
      CREATE INDEX IF NOT EXISTS events_timeline ON events(owner_id, captured_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS forwarding_config (id INTEGER PRIMARY KEY CHECK(id=1), url TEXT NOT NULL, token TEXT NOT NULL, enabled INTEGER NOT NULL, destination TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forwarding_jobs (event_id TEXT NOT NULL REFERENCES events(id), destination TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, cloud_id TEXT, error TEXT, PRIMARY KEY(event_id,destination));
      CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);`);
  }
  async ingest(owner, input) {
    const { event, fingerprint, dedupeKey, documentKey, image, dimensions } =
      input;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = hydrate(
        this.db
          .prepare("SELECT * FROM events WHERE owner_id=? AND dedupe_key=?")
          .get(owner, dedupeKey),
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "This checkpoint ID already belongs to different content.",
          );
        if (previous.deleted_at)
          throw new HttpError(
            409,
            "This checkpoint was deleted; it will not be recreated by a retry.",
          );
        this.db.exec("COMMIT");
        return { row: previous, duplicate: true };
      }
      this.db
        .prepare(
          "INSERT INTO documents VALUES(?,?,?,?,?) ON CONFLICT(owner_id,source,source_key) DO UPDATE SET name=excluded.name",
        )
        .run(
          randomUUID(),
          owner,
          event.source,
          documentKey,
          event.document.name,
        );
      const document = this.db
        .prepare(
          "SELECT id FROM documents WHERE owner_id=? AND source=? AND source_key=?",
        )
        .get(owner, event.source, documentKey);
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO events(id,owner_id,document_id,dedupe_key,fingerprint,raw_event,captured_at,received_at,image,image_bytes,image_dimensions) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          owner,
          document.id,
          dedupeKey,
          fingerprint,
          JSON.stringify(event),
          new Date(event.timestamp).toISOString(),
          new Date().toISOString(),
          image,
          image.length,
          JSON.stringify(dimensions),
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO forwarding_jobs(event_id,destination)
        SELECT ?,destination FROM forwarding_config WHERE enabled=1`,
        )
        .run(id);
      this.db.exec("COMMIT");
      return { row: await this.get(owner, id), duplicate: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async get(owner, id) {
    return hydrate(
      this.db
        .prepare(
          "SELECT * FROM events WHERE owner_id=? AND id=? AND deleted_at IS NULL",
        )
        .get(owner, id),
    );
  }
  async image(row) {
    const bytes =
      row.image ??
      this.db
        .prepare(
          "SELECT image FROM events WHERE id=? AND owner_id=? AND deleted_at IS NULL",
        )
        .get(row.id, row.owner_id)?.image;
    if (!bytes) throw new HttpError(404, "Viewport not found.");
    return Buffer.from(bytes);
  }
  async list(owner, { documentId, status, q, cursor, limit = 30 } = {}) {
    const where = ["owner_id=?", "deleted_at IS NULL"];
    const args = [owner];
    if (documentId) {
      where.push("document_id=?");
      args.push(documentId);
    }
    if (status) {
      where.push("status=?");
      args.push(status);
    }
    if (q) {
      where.push("instr(lower(raw_event || COALESCE(ai,'')),lower(?))>0");
      args.push(q);
    }
    if (cursor) {
      where.push("(captured_at < ? OR (captured_at = ? AND id < ?))");
      args.push(cursor.time, cursor.time, cursor.id);
    }
    // Never materialize every PNG when listing/exporting a document. Images are
    // loaded individually after the export size limit has been checked.
    return this.db
      .prepare(
        `SELECT id,owner_id,document_id,raw_event,captured_at,received_at,status,ai,ai_provider,ai_model,error,image_bytes,image_dimensions FROM events WHERE ${where.join(" AND ")} ORDER BY captured_at DESC,id DESC LIMIT ?`,
      )
      .all(...args, limit)
      .map(hydrate);
  }
  async documents(owner) {
    return this.db
      .prepare(
        `SELECT d.id,d.name,d.source,COUNT(e.id) AS event_count,MAX(e.captured_at) AS latest_at,
      SUM(CASE WHEN e.status='complete' THEN 1 ELSE 0 END) AS complete_count,
      SUM(CASE WHEN e.status IN ('pending','processing') THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) AS failed_count
      FROM documents d JOIN events e ON e.document_id=d.id AND e.deleted_at IS NULL
      WHERE d.owner_id=? GROUP BY d.id ORDER BY latest_at DESC`,
      )
      .all(owner);
  }
  async claim() {
    const now = Date.now(),
      lease = randomUUID();
    return hydrate(
      this.db
        .prepare(
          `UPDATE events SET status='processing',lease_id=?,lease_until=?,attempts=attempts+1
      WHERE id=(SELECT id FROM events WHERE deleted_at IS NULL AND attempts<3 AND
      ((status='pending' AND available_at<=?) OR (status='processing' AND lease_until<?)) ORDER BY received_at LIMIT 1)
      RETURNING *`,
        )
        .get(lease, now + 180_000, now, now),
    );
  }
  async settle(row, result, error) {
    const status = error
      ? row.attempts < 3
        ? "pending"
        : "failed"
      : "complete";
    this.db
      .prepare(
        `UPDATE events SET status=?,ai=?,ai_provider=?,ai_model=?,prompt_version=?,error=?,available_at=?,lease_until=0
      WHERE id=? AND lease_id=? AND deleted_at IS NULL`,
      )
      .run(
        status,
        result ? JSON.stringify(result.ai) : null,
        result?.provider ?? null,
        result?.model ?? null,
        result?.promptVersion ?? null,
        error ?? null,
        Date.now() + row.attempts * 5000,
        row.id,
        row.lease_id,
      );
  }
  async recoverExhausted() {
    this.db
      .prepare(
        "UPDATE events SET status='failed',error='Processing interrupted after three attempts.' WHERE status='processing' AND attempts>=3 AND lease_until<? AND deleted_at IS NULL",
      )
      .run(Date.now());
  }
  async retry(owner, id) {
    return (
      this.db
        .prepare(
          "UPDATE events SET status='pending',attempts=0,available_at=0,error=NULL WHERE owner_id=? AND id=? AND status='failed' AND deleted_at IS NULL",
        )
        .run(owner, id).changes > 0
    );
  }
  async delete(owner, id) {
    return (
      this.db
        .prepare(
          "UPDATE events SET deleted_at=?,image=NULL,raw_event=?,ai=NULL WHERE owner_id=? AND id=? AND deleted_at IS NULL",
        )
        .run(new Date().toISOString(), "{}", owner, id).changes > 0
    );
  }
  async createToken(owner, token) {
    this.db
      .prepare(
        "INSERT INTO tokens(id,owner_id,name,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        token.id,
        owner,
        token.name,
        token.token_hash,
        token.prefix,
        token.created_at,
      );
  }
  async tokens(owner) {
    return this.db
      .prepare(
        "SELECT id,name,prefix,created_at,revoked_at FROM tokens WHERE owner_id=? ORDER BY created_at DESC",
      )
      .all(owner);
  }
  async tokenOwner(digest) {
    return this.db
      .prepare(
        "SELECT owner_id FROM tokens WHERE token_hash=? AND revoked_at IS NULL",
      )
      .get(digest)?.owner_id;
  }
  async revokeToken(owner, id) {
    return (
      this.db
        .prepare(
          "UPDATE tokens SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL",
        )
        .run(new Date().toISOString(), id, owner).changes > 0
    );
  }
  close() {
    this.db.close();
  }
}
