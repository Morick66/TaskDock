import { randomUUID } from "node:crypto";
import { ApiError } from "../shared/api-fields.mjs";

export const executorSchema = { type: "string", enum: ["user", "agent"] };
export const checklistProperties = {
  title: { type: "string" }, executor: executorSchema,
  status: { type: "string", enum: ["pending", "done", "issue"] },
  ready: { type: "boolean" }, note: { type: "string" },
  attachmentIds: { type: "array", items: { type: "string" } },
};

export function parseExecutor(value) {
  if (value !== "user" && value !== "agent") throw new ApiError(400, "INVALID_EXECUTOR", "executor must be user or agent");
  return value;
}

export function createChecklistStore(db, actor) {
  const sql = db.database;
  sql.exec(`CREATE TABLE IF NOT EXISTS agentboard_checklist_items (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL, executor TEXT NOT NULL, status TEXT NOT NULL,
    ready INTEGER NOT NULL, note TEXT NOT NULL, attachment_ids TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS agentboard_checklist_task ON agentboard_checklist_items(task_id, created_at);`);
  function list(taskId) {
    return sql.prepare("SELECT * FROM agentboard_checklist_items WHERE task_id = ? ORDER BY created_at, id").all(taskId).map((row) => ({
      id: row.id, title: row.title, executor: row.executor, status: row.status,
      ready: Boolean(row.ready), note: row.note, attachmentIds: JSON.parse(row.attachment_ids),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }
  function save(principal, task, itemId, input, remove = false) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new ApiError(400, "INVALID_VERSION", "Current task version is required");
    if (task.version !== input.version) throw new ApiError(409, "VERSION_CONFLICT", "Task changed; refresh before saving");
    if (principal.role === "agent" && task.claimedBy?.id !== principal.id) throw new ApiError(403, "CLAIM_NOT_OWNED", "Claim the task before editing its checklist");
    const before = itemId ? list(task.id).find((item) => item.id === itemId) : null;
    if (itemId && !before) throw new ApiError(404, "CHECKLIST_ITEM_NOT_FOUND", "Checklist item not found");
    for (const key of Object.keys(input)) {
      if (!["version", ...Object.keys(checklistProperties)].includes(key)) throw new ApiError(400, "INVALID_FIELD", `Unknown checklist field: ${key}`);
    }
    const next = { id: itemId ?? randomUUID(), title: "", executor: "user", status: "pending", ready: true, note: "", attachmentIds: [], ...before, ...input };
    delete next.version;
    if (typeof next.title !== "string" || !next.title.trim() || next.title.length > 1000) throw new ApiError(400, "INVALID_FIELD", "Checklist title is required (maximum 1000 characters)");
    next.title = next.title.trim();
    parseExecutor(next.executor);
    if (!["pending", "done", "issue"].includes(next.status) || typeof next.ready !== "boolean" || typeof next.note !== "string" || next.note.length > 100_000) throw new ApiError(400, "INVALID_FIELD", "Invalid checklist status, readiness or note");
    if (!Array.isArray(next.attachmentIds) || next.attachmentIds.some((id) => typeof id !== "string" || !sql.prepare("SELECT 1 FROM attachments WHERE id = ? AND task_id = ?").get(id, task.id))) throw new ApiError(400, "INVALID_ATTACHMENT", "Checklist attachments must belong to this task");
    if (principal.role === "agent" && ((before?.executor === "user" && (remove || next.status !== before.status || next.executor !== before.executor)) || (before?.executor !== "user" && next.executor === "user" && next.status !== "pending"))) {
      throw new ApiError(403, "USER_RESULT_REQUIRED", "Only the user can change the result of a user checklist item");
    }
    const at = new Date().toISOString();
    next.createdAt = before?.createdAt ?? at;
    next.updatedAt = at;
    sql.exec("BEGIN IMMEDIATE");
    try {
      const result = sql.prepare("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(at, task.id, input.version);
      if (result.changes !== 1) throw new ApiError(409, "VERSION_CONFLICT", "Task changed; refresh before saving");
      if (remove) sql.prepare("DELETE FROM agentboard_checklist_items WHERE id = ?").run(itemId);
      else sql.prepare(`INSERT INTO agentboard_checklist_items (id, task_id, title, executor, status, ready, note, attachment_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, executor=excluded.executor,
        status=excluded.status, ready=excluded.ready, note=excluded.note, attachment_ids=excluded.attachment_ids, updated_at=excluded.updated_at`)
        .run(next.id, task.id, next.title, next.executor, next.status, Number(next.ready), next.note, JSON.stringify(next.attachmentIds), next.createdAt, at);
      const who = actor(principal);
      sql.prepare("INSERT INTO task_activities (id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)")
        .run(randomUUID(), task.id, who.type, who.id, who.name, JSON.stringify([{ field: "checklist", before, after: remove ? null : next }]), at);
      sql.exec("COMMIT");
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
  }
  return { list, save };
}
