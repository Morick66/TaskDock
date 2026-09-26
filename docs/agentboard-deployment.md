# Deploy TaskDock

TaskDock runs as one Node service with a SQLite database and attachment files. The Docker image builds the Web board and starts `server/agentboard-server.mjs`. Mount `/data` persistently; it holds `taskboard.sqlite` and `attachments/`.

## Start a new service

Create a `.env` next to `compose.yaml` with unique secrets:

```dotenv
AGENTBOARD_ADMIN_KEY=replace-with-a-long-random-admin-key
AGENTBOARD_SESSION_SECRET=replace-with-a-long-random-session-secret
AGENTBOARD_PORT=47823
```

Then run `docker compose up --build -d` and open `http://localhost:47823`. Compose binds the service to the host loopback address by default; set `AGENTBOARD_BIND_HOST` only if a separate reverse proxy must connect over the host network. Put an HTTPS reverse proxy in front of the service when exposing it outside the host, so Agent keys and Web login credentials travel over TLS. Keep `.env` and the `agentboard-data/` directory private.

The container runs as UID 1000. On a Linux host, create `agentboard-data/` and make it writable by UID 1000 before starting Compose (`mkdir -p agentboard-data && sudo chown 1000:1000 agentboard-data`). An imported directory needs the same ownership. Docker Desktop typically handles host folder permissions through its file sharing layer.

TaskDock has one Web login. Use `AGENTBOARD_ADMIN_KEY` as the login Key to view dashboards and tasks and to create, archive, restore, or delete empty projects and configure Agent identities. The same user Key authenticates management API requests: `POST /api/projects` and `POST /api/agents` with `{ "id", "name" }`. Creating an Agent generates its API Key in the same request; the plaintext Key appears once in the response. `POST /api/agents/:id/keys` resets that Agent's Key and revokes its previous Key. `DELETE /api/agents/:id/keys/:keyId` revokes a Key. `DELETE /api/agents/:id` removes the Agent from management, deletes its Keys, and releases its claimed tasks while retaining historical activity and artifacts. Each Agent Key can access every active project through REST or remote `/mcp` as `Authorization: Bearer <key>`. Agent task routes include `POST /api/tasks/:id/claim`, `/release`, `/comments`, and `/artifacts`. Upload a file with a raw request body to `POST /api/tasks/:id/attachments` and set `X-Taskboard-Filename`.

In Web **管理设置**, expand **Agent 接入说明** and use **复制给 Agent** to get an installation prompt. It links to the public `GET /skills/taskdock-collaboration/SKILL.md` file and contains the REST and MCP URLs, but never includes an API Key. Configure each Agent's Key in that Agent's own environment or credential store.

## Import a local Taskboard

Stop the old Taskboard before final cutover so no new writes occur after the snapshot. Run this command **before** the first `docker compose up`:

```sh
node scripts/import-local-data.mjs /path/to/old/.data ./agentboard-data
```

The source directory must contain `taskboard.sqlite`; the import also copies `attachments/` when present. The target directory must not exist. The command uses SQLite's `VACUUM INTO` to include committed WAL data in one consistent database snapshot, then copies files and publishes the new directory. TaskDock upgrades the database schema on first startup. Historical tasks, comments, and attachments remain visible; old assignees are historical display data and do not create a new Agent claim.

On Windows PowerShell, quote paths containing spaces:

```powershell
node scripts/import-local-data.mjs 'D:\old-taskboard\.data' '.\agentboard-data'
```

## Persistence check

Create a project and task, attach a file, and submit an artifact. Restart with `docker compose restart agentboard`, then read the project and task from the API and check the Web board. The project, Agent keys, task history, artifact, and attachment should remain available because `/data` is persisted.
