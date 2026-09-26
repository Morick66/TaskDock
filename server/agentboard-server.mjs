import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskboardDatabase } from "./database.mjs";
import { ApiError, validateProjectId } from "../shared/api-fields.mjs";
import { parseTaskCreate, parseTaskPatch, parseTaskFilters } from "../shared/task-input.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 1024 * 1024;
const CONTENT_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const actor = (principal) => ({ type: "agent", id: principal.id, name: principal.name, avatarUrl: null });
const safeEqual = (left, right) => {
  const a = Buffer.from(hash(left), "hex");
  const b = Buffer.from(hash(right), "hex");
  return timingSafeEqual(a, b);
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, "BODY_TOO_LARGE", "Request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
    return value;
  }
  catch { throw new ApiError(400, "INVALID_JSON", "Expected a JSON object"); }
}

function requiredString(value, name, max = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

function artifactFromRow(row) {
  return { id: row.id, taskId: row.task_id, type: row.type, title: row.title, content: row.content, url: row.url,
    attachmentId: row.attachment_id, agentId: row.agent_id, agentName: row.agent_name, createdAt: row.created_at };
}

export function createAgentBoardServer(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = path.resolve(options.dataDirectory ?? env.AGENTBOARD_DATA_DIR ?? path.join(ROOT, ".data"));
  const staticDir = path.resolve(options.staticDirectory ?? path.join(ROOT, "dist", "web"));
  const attachmentsDir = path.join(dataDir, "attachments");
  const adminKey = options.adminKey ?? env.AGENTBOARD_ADMIN_KEY;
  const sessionSecret = options.sessionSecret ?? env.AGENTBOARD_SESSION_SECRET;
  if (!adminKey || !sessionSecret) {
    throw new Error("AGENTBOARD_ADMIN_KEY and AGENTBOARD_SESSION_SECRET are required");
  }
  const db = new TaskboardDatabase(path.join(dataDir, "taskboard.sqlite"));
  const sql = db.database;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agentboard_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agentboard_agent_projects (agent_id TEXT NOT NULL REFERENCES agentboard_agents(id), project_id TEXT NOT NULL REFERENCES projects(id), PRIMARY KEY(agent_id, project_id));
    CREATE TABLE IF NOT EXISTS agentboard_keys (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agentboard_agents(id), key_hash TEXT NOT NULL UNIQUE, revoked_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agentboard_claims (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agentboard_agents(id), claimed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agentboard_project_archives (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agentboard_artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agentboard_agents(id), agent_name TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT, url TEXT, attachment_id TEXT REFERENCES attachments(id), created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agentboard_artifacts_task ON agentboard_artifacts(task_id, created_at);
  `);

  function authenticate(request) {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    if (bearer && safeEqual(bearer[1], adminKey)) return { role: "admin", id: "admin", name: "Administrator" };
    if (bearer) {
      const row = sql.prepare(`SELECT a.id, a.name FROM agentboard_keys k JOIN agentboard_agents a ON a.id = k.agent_id WHERE k.key_hash = ? AND k.revoked_at IS NULL`).get(hash(bearer[1]));
      if (row) return { ...row, role: "agent" };
    }
    const cookie = /(?:^|;\s*)agentboard_session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    if (cookie) {
      const [role, expiry, proof] = cookie.split(".");
      if (role === "admin" && /^\d+$/.test(expiry) && proof && Number(expiry) > Date.now() && safeEqual(proof, hash(`${role}:${expiry}:${sessionSecret}`))) {
        return { role: "admin", id: "admin", name: "User" };
      }
    }
    throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
  }

  function scope(principal, projectId) {
    if (principal.role === "admin") return;
    activeProject(projectId);
  }
  function admin(principal) {
    if (principal.role !== "admin") throw new ApiError(403, "ADMIN_REQUIRED", "Administrator key required");
  }
  function sessionCookie(request) {
    const expiry = String(Date.now() + 24 * 60 * 60 * 1000);
    const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return `agentboard_session=admin.${expiry}.${hash(`admin:${expiry}:${sessionSecret}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`;
  }
  function projectArchived(projectId) {
    return Boolean(sql.prepare("SELECT 1 FROM agentboard_project_archives WHERE project_id = ?").get(projectId));
  }
  function activeProject(projectId) {
    if (!db.getProject(projectId)) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    if (projectArchived(projectId)) throw new ApiError(409, "PROJECT_ARCHIVED", "Restore the project before changing its tasks or grants");
  }
  function projectInfo(project) {
    const row = sql.prepare("SELECT archived_at FROM agentboard_project_archives WHERE project_id = ?").get(project.id);
    return { ...project, archivedAt: row?.archived_at ?? null };
  }
  function agentInfo(agentId) {
    const row = sql.prepare("SELECT id, name, created_at FROM agentboard_agents WHERE id = ?").get(agentId);
    if (!row) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
    const keys = sql.prepare("SELECT id, created_at, revoked_at FROM agentboard_keys WHERE agent_id = ? ORDER BY created_at DESC").all(agentId).map((key) => ({ id: key.id, createdAt: key.created_at, revokedAt: key.revoked_at }));
    return { id: row.id, name: row.name, createdAt: row.created_at, keys };
  }
  function taskFor(principal, id) {
    const task = db.getTask(id);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
    scope(principal, task.projectId);
    const claim = sql.prepare("SELECT a.id, a.name FROM agentboard_claims c JOIN agentboard_agents a ON a.id = c.agent_id WHERE c.task_id = ?").get(task.id);
    return { ...task, claimedBy: claim ? actor(claim) : null };
  }
  function owner(principal, task) {
    if (principal.role === "admin") return;
    if (task.claimedBy?.id !== principal.id) throw new ApiError(403, "CLAIM_REQUIRED", "This task is claimed by another Agent or is unclaimed");
  }
  function event(taskId, principal, field, oldValue, newValue) {
    sql.prepare(`INSERT INTO task_activities (id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at) VALUES (?, ?, 'agent', ?, ?, NULL, ?, ?)`).run(
      randomUUID(), taskId, principal.id, principal.name, JSON.stringify([{ field, before: oldValue, after: newValue }]), new Date().toISOString());
  }
  function transition(principal, task, action, version) {
    activeProject(task.projectId);
    if (action === "claim" && principal.role !== "agent") throw new ApiError(403, "AGENT_REQUIRED", "Only an Agent can claim tasks");
    if (!Number.isSafeInteger(version) || version < 1) throw new ApiError(400, "INVALID_VERSION", "Current task version is required");
    const current = taskFor(principal, task.id);
    if (current.version !== version) throw new ApiError(409, "VERSION_CONFLICT", "Task version changed");
    if (action === "claim" && (current.status !== "todo" || current.claimedBy || current.archivedAt)) {
      throw new ApiError(409, "TASK_NOT_CLAIMABLE", "Task must be an unclaimed, active todo");
    }
    if (action === "release") owner(principal, current);
    sql.exec("BEGIN IMMEDIATE");
    try {
      const nextStatus = action === "claim" ? "in_progress" : "todo";
      const updated = sql.prepare("UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(nextStatus, new Date().toISOString(), current.id, version);
      if (updated.changes !== 1) throw new ApiError(409, "VERSION_CONFLICT", "Task version changed");
      if (action === "claim") sql.prepare("INSERT INTO agentboard_claims (task_id, agent_id, claimed_at) VALUES (?, ?, ?)").run(current.id, principal.id, new Date().toISOString());
      else sql.prepare("DELETE FROM agentboard_claims WHERE task_id = ?").run(current.id);
      event(current.id, principal, "claim", action === "claim" ? null : current.claimedBy, action === "claim" ? actor(principal) : null);
      sql.exec("COMMIT");
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
    return taskFor(principal, current.id);
  }
  function submitArtifact(principal, task, input) {
    owner(principal, task);
    activeProject(task.projectId);
    const type = requiredString(input.type, "type", 40);
    const title = requiredString(input.title, "title");
    const content = input.content == null ? null : requiredString(input.content, "content", 100_000);
    const url = input.url == null ? null : requiredString(input.url, "url", 2048);
    const attachmentId = input.attachmentId ?? null;
    if (!content && !url && !attachmentId) throw new ApiError(400, "INVALID_ARTIFACT", "Artifact needs content, url or attachmentId");
    if (url && !/^https?:\/\//.test(url)) throw new ApiError(400, "INVALID_URL", "Artifact URL must use HTTP or HTTPS");
    if (attachmentId && !sql.prepare("SELECT 1 FROM attachments WHERE id = ? AND task_id = ?").get(attachmentId, task.id)) throw new ApiError(400, "INVALID_ATTACHMENT", "Attachment does not belong to task");
    const id = randomUUID(); const createdAt = new Date().toISOString();
    sql.exec("BEGIN IMMEDIATE");
    try {
      sql.prepare("INSERT INTO agentboard_artifacts (id, task_id, agent_id, agent_name, type, title, content, url, attachment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, task.id, principal.id, principal.name, type, title, content, url, attachmentId, createdAt);
      event(task.id, principal, "artifact", null, { id, title, type });
      sql.exec("COMMIT");
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
    return artifactFromRow(sql.prepare("SELECT * FROM agentboard_artifacts WHERE id = ?").get(id));
  }
  async function operation(principal, name, args = {}) {
    if (name === "list_tasks") {
      const filters = { projectId: args.projectId, status: args.status, archived: "false" };
      if (filters.projectId) scope(principal, filters.projectId);
      const tasks = db.listTasks(filters).filter((task) => principal.role === "admin" || !projectArchived(task.projectId));
      return { tasks: tasks.map((task) => taskFor(principal, task.id)) };
    }
    if (name === "get_task") return { task: taskFor(principal, args.taskId) };
    const task = taskFor(principal, args.taskId);
    if (name === "claim_task" || name === "release_task") return { task: transition(principal, task, name === "claim_task" ? "claim" : "release", args.version) };
    if (name === "update_task") {
      owner(principal, task);
      activeProject(task.projectId);
      const { taskId: _taskId, ...patch } = args;
      const { version, changes, assigneeTarget, threadId, threadBinding, agentSession } = parseTaskPatch(patch, () => null);
      if (assigneeTarget !== undefined || threadId || threadBinding || agentSession || changes.projectId) throw new ApiError(400, "INVALID_FIELD", "AgentBoard task updates cannot change identity, project or session fields");
      return { task: taskFor(principal, db.updateTask(task.id, version, changes, undefined, undefined, actor(principal), undefined).id) };
    }
    if (name === "add_comment") {
      activeProject(task.projectId);
      const comment = db.createComment(task.id, { body: requiredString(args.body, "body", 100_000), actor: actor(principal) });
      return { comment };
    }
    if (name === "submit_artifact") return { artifact: submitArtifact(principal, task, args) };
    throw new ApiError(404, "UNKNOWN_OPERATION", "Unknown operation");
  }

  async function serve(request, response) {
    const url = new URL(request.url, "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/health") return json(response, 200, { status: "ok" });
    if (pathname === "/api/meta" && request.method === "GET") return json(response, 200, { mode: "agentboard", productName: "TaskDock", realtime: { transport: "poll", intervalMs: 3000 }, capabilities: { localAiChat: false } });
    if (pathname === "/skills/taskdock-collaboration/SKILL.md" && request.method === "GET") {
      const skill = await readFile(path.join(ROOT, "skills", "taskdock-collaboration", "SKILL.md"));
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
      return response.end(skill);
    }
    if (request.method === "GET" && !pathname.startsWith("/api/") && pathname !== "/mcp") {
      let target = path.resolve(staticDir, `.${pathname}`);
      if (!target.startsWith(`${staticDir}${path.sep}`) && target !== staticDir) throw new ApiError(404, "NOT_FOUND", "Not found");
      try { if (!(await stat(target)).isFile()) target = path.join(staticDir, "index.html"); }
      catch { target = path.join(staticDir, "index.html"); }
      const data = await readFile(target);
      response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
      return response.end(data);
    }
    if (pathname === "/api/agentboard/login" && request.method === "POST") {
      const input = await body(request);
      if (!safeEqual(String(input.key ?? ""), adminKey)) throw new ApiError(401, "INVALID_LOGIN", "Invalid login key");
      return json(response, 200, { authenticated: true }, { "set-cookie": sessionCookie(request) });
    }
    if (pathname === "/api/agentboard/logout" && request.method === "POST") {
      return json(response, 200, { authenticated: false }, { "set-cookie": "agentboard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    }
    if (pathname === "/api/agentboard/session" && request.method === "GET") {
      try { const session = authenticate(request); return json(response, 200, { authenticated: true, role: session.role }); }
      catch { return json(response, 200, { authenticated: false }); }
    }
    const principal = authenticate(request);
    if (pathname === "/api/revisions" && request.method === "GET") return json(response, 200, { changed: true, revision: Date.now() });
    if (pathname === "/api/agents" && request.method === "GET") {
      admin(principal);
      return json(response, 200, { agents: sql.prepare("SELECT id FROM agentboard_agents ORDER BY created_at, id").all().map((row) => agentInfo(row.id)) });
    }
    if (pathname === "/api/agents" && request.method === "POST") {
      admin(principal); const input = await body(request);
      const id = requiredString(input.id, "id", 96); const name = requiredString(input.name, "name", 120);
      if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) throw new ApiError(400, "INVALID_AGENT_ID", "Agent ID must be a URL-safe identifier");
      const key = `agb_${randomBytes(32).toString("base64url")}`;
      sql.exec("BEGIN IMMEDIATE");
      try {
        sql.prepare("INSERT INTO agentboard_agents (id, name, created_at) VALUES (?, ?, ?)").run(id, name, new Date().toISOString());
        sql.prepare("INSERT INTO agentboard_keys (id, agent_id, key_hash, created_at) VALUES (?, ?, ?, ?)").run(randomUUID(), id, hash(key), new Date().toISOString());
        sql.exec("COMMIT");
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
      return json(response, 201, { agent: agentInfo(id), key });
    }
    const agentRoute = /^\/api\/agents\/([^/]+)$/.exec(pathname);
    if (agentRoute && request.method === "PATCH") {
      admin(principal); const id = decodeURIComponent(agentRoute[1]);
      agentInfo(id);
      const input = await body(request);
      const name = requiredString(input.name, "name", 120);
      sql.prepare("UPDATE agentboard_agents SET name = ? WHERE id = ?").run(name, id);
      return json(response, 200, { agent: agentInfo(id) });
    }
    const keyRoute = /^\/api\/agents\/([^/]+)\/keys(?:\/([^/]+))?$/.exec(pathname);
    if (keyRoute) {
      admin(principal); const agentId = decodeURIComponent(keyRoute[1]);
      if (!sql.prepare("SELECT 1 FROM agentboard_agents WHERE id = ?").get(agentId)) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found");
      if (request.method === "POST" && !keyRoute[2]) {
        const key = `agb_${randomBytes(32).toString("base64url")}`; const id = randomUUID();
        sql.exec("BEGIN IMMEDIATE");
        try {
          sql.prepare("UPDATE agentboard_keys SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(new Date().toISOString(), agentId);
          sql.prepare("INSERT INTO agentboard_keys (id, agent_id, key_hash, created_at) VALUES (?, ?, ?, ?)").run(id, agentId, hash(key), new Date().toISOString());
          sql.exec("COMMIT");
        } catch (error) { sql.exec("ROLLBACK"); throw error; }
        return json(response, 201, { id, key });
      }
      if (request.method === "DELETE" && keyRoute[2]) {
        const result = sql.prepare("UPDATE agentboard_keys SET revoked_at = ? WHERE id = ? AND agent_id = ? AND revoked_at IS NULL").run(new Date().toISOString(), decodeURIComponent(keyRoute[2]), agentId);
        if (!result.changes) throw new ApiError(404, "KEY_NOT_FOUND", "Key not found");
        response.writeHead(204); return response.end();
      }
    }
    if (pathname === "/api/projects" && request.method === "GET") {
      const projects = db.listProjects().filter((p) => (p.id !== "local" || p.issueCount > 0) && (principal.role === "admin" || !projectArchived(p.id))).map(projectInfo);
      return json(response, 200, { projects });
    }
    if (pathname === "/api/projects" && request.method === "POST") {
      admin(principal); const input = await body(request);
      return json(response, 201, { project: projectInfo(db.createProject({ id: validateProjectId(input.id), name: requiredString(input.name, "name"), workspacePath: null })) });
    }
    const projectRoute = /^\/api\/projects\/([^/]+)(?:\/(archive|restore))?$/.exec(pathname);
    if (projectRoute) {
      admin(principal); const id = decodeURIComponent(projectRoute[1]);
      if (id === "local") throw new ApiError(403, "SYSTEM_PROJECT", "The global project cannot be archived or deleted");
      const project = db.getProject(id);
      if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
      if (request.method === "POST" && projectRoute[2] === "archive") {
        sql.prepare("INSERT INTO agentboard_project_archives (project_id, archived_at) VALUES (?, ?) ON CONFLICT(project_id) DO NOTHING").run(id, new Date().toISOString());
        return json(response, 200, { project: projectInfo(project) });
      }
      if (request.method === "POST" && projectRoute[2] === "restore") {
        sql.prepare("DELETE FROM agentboard_project_archives WHERE project_id = ?").run(id);
        return json(response, 200, { project: projectInfo(project) });
      }
      if (request.method === "DELETE" && !projectRoute[2]) {
        const issueCount = sql.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?").get(id).count;
        if (issueCount) throw new ApiError(409, "PROJECT_NOT_EMPTY", "Archive projects that still contain tasks");
        sql.exec("BEGIN IMMEDIATE");
        try {
          sql.prepare("DELETE FROM agentboard_agent_projects WHERE project_id = ?").run(id);
          sql.prepare("DELETE FROM projects WHERE id = ?").run(id);
          sql.exec("COMMIT");
        } catch (error) { sql.exec("ROLLBACK"); throw error; }
        response.writeHead(204); return response.end();
      }
    }
    if (pathname === "/api/tasks" && request.method === "GET") {
      const filters = parseTaskFilters(url.searchParams);
      return json(response, 200, await operation(principal, "list_tasks", filters));
    }
    if (pathname === "/api/tasks" && request.method === "POST") {
      const input = await body(request);
      const parsed = parseTaskCreate({ status: "todo", ...input }, () => null);
      scope(principal, parsed.projectId);
      activeProject(parsed.projectId);
      if (parsed.assigneeTarget || parsed.threadId || parsed.threadBinding || parsed.agentSession) throw new ApiError(400, "INVALID_FIELD", "AgentBoard does not accept client identity fields");
      return json(response, 201, { task: taskFor(principal, db.createTask({ ...parsed, actor: actor(principal), assignee: actor(principal) }).id) });
    }
    const match = /^\/api\/tasks\/([^/]+)(?:\/(claim|release|comments|activities|artifacts|attachments))?$/.exec(pathname);
    if (match) {
      const id = decodeURIComponent(match[1]); const task = taskFor(principal, id); const action = match[2];
      if (!action && request.method === "GET") return json(response, 200, { task });
      if (!action && request.method === "PATCH") return json(response, 200, await operation(principal, "update_task", { ...await body(request), taskId: id }));
      if ((action === "claim" || action === "release") && request.method === "POST") return json(response, 200, await operation(principal, `${action}_task`, { ...await body(request), taskId: id }));
      if (action === "comments" && request.method === "GET") return json(response, 200, { comments: db.listComments(task.id) });
      if (action === "comments" && request.method === "POST") return json(response, 201, await operation(principal, "add_comment", { ...await body(request), taskId: id }));
      if (action === "activities" && request.method === "GET") return json(response, 200, { activities: db.listTaskActivities(task.id) });
      if (action === "artifacts" && request.method === "GET") return json(response, 200, { artifacts: sql.prepare("SELECT * FROM agentboard_artifacts WHERE task_id = ? ORDER BY created_at, id").all(task.id).map(artifactFromRow) });
      if (action === "artifacts" && request.method === "POST") return json(response, 201, await operation(principal, "submit_artifact", { ...await body(request), taskId: id }));
      if (action === "attachments" && request.method === "GET") return json(response, 200, { attachments: db.listAttachments(task.id) });
      if (action === "attachments" && request.method === "POST") {
        owner(principal, task);
        activeProject(task.projectId);
        let filename;
        try { filename = decodeURIComponent(requiredString(request.headers["x-taskboard-filename"], "filename", 512)); }
        catch { throw new ApiError(400, "INVALID_FILENAME", "Invalid encoded filename"); }
        if (!filename || filename.includes("/") || filename.includes("\\")) throw new ApiError(400, "INVALID_FILENAME", "Filename must not contain path separators");
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 25 * 1024 * 1024) throw new ApiError(413, "ATTACHMENT_TOO_LARGE", "Attachment exceeds 25 MiB");
          chunks.push(chunk);
        }
        const attachmentId = randomUUID();
        await mkdir(attachmentsDir, { recursive: true });
        const file = path.join(attachmentsDir, attachmentId);
        await writeFile(file, Buffer.concat(chunks), { flag: "wx" });
        try {
          const attachment = db.createAttachment(task.id, { id: attachmentId, kind: "attachment", filename, contentType: request.headers["content-type"] || "application/octet-stream", size });
          return json(response, 201, { attachment });
        } catch (error) { await unlink(file); throw error; }
      }
    }
    const attachment = /^\/api\/attachments\/([^/]+)\/(content|download)$/.exec(pathname);
    if (attachment && (request.method === "GET" || request.method === "HEAD")) {
      const record = db.getAttachment(decodeURIComponent(attachment[1]));
      if (!record) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");
      taskFor(principal, record.taskId);
      const file = path.join(attachmentsDir, record.id);
      const info = await stat(file);
      response.writeHead(200, { "content-type": attachment[2] === "content" ? record.contentType : "application/octet-stream", "content-length": info.size, "cache-control": "private, no-store", "content-security-policy": "sandbox; default-src 'none'" });
      if (request.method === "HEAD") return response.end();
      return createReadStream(file).pipe(response);
    }
    if (pathname === "/mcp" && request.method === "POST") {
      const rpc = await body(request);
      if (rpc.method === "initialize") return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: rpc.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "TaskDock", version: "1.0.0" } } });
      if (rpc.method === "notifications/initialized") { response.writeHead(202); return response.end(); }
      if (rpc.method === "tools/list") return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [
        ["list_tasks", "List tasks in an authorized project", { projectId: { type: "string" }, status: { type: "string" } }, []],
        ["get_task", "Get one task and its current claim", { taskId: { type: "string" } }, ["taskId"]],
        ["claim_task", "Claim an unclaimed todo", { taskId: { type: "string" }, version: { type: "integer" } }, ["taskId", "version"]],
        ["release_task", "Release your claim", { taskId: { type: "string" }, version: { type: "integer" } }, ["taskId", "version"]],
        ["update_task", "Update your claimed task", { taskId: { type: "string" }, version: { type: "integer" }, status: { type: "string" }, title: { type: "string" }, description: { type: "string" } }, ["taskId", "version"]],
        ["add_comment", "Add context to a task", { taskId: { type: "string" }, body: { type: "string" } }, ["taskId", "body"]],
        ["submit_artifact", "Record an output on your claimed task", { taskId: { type: "string" }, type: { type: "string" }, title: { type: "string" }, content: { type: "string" }, url: { type: "string" }, attachmentId: { type: "string" } }, ["taskId", "type", "title"]],
      ].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: "object", properties, required } })) } });
      if (rpc.method === "tools/call") {
        try { const value = await operation(principal, rpc.params?.name, rpc.params?.arguments); return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } }); }
        catch (error) { return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: error.message }] } }); }
      }
      return json(response, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    }
    throw new ApiError(404, "NOT_FOUND", "Route not found");
  }
  const server = createServer((request, response) => serve(request, response).catch((error) => {
    json(response, error.status ?? 500, { error: { code: error.code ?? "INTERNAL_ERROR", message: error.status ? error.message : "Internal server error" } });
  }));
  return { server, database: db, listen: ({ host = "0.0.0.0", port = 47823 } = {}) => new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(server.address()); });
  }), close: () => new Promise((resolve, reject) => server.close((error) => { db.close(); error ? reject(error) : resolve(); })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createAgentBoardServer();
  app.listen({ host: process.env.AGENTBOARD_HOST ?? "0.0.0.0", port: Number(process.env.AGENTBOARD_PORT ?? 47823) })
    .then((address) => console.log(`AgentBoard listening on ${address.address}:${address.port}`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
