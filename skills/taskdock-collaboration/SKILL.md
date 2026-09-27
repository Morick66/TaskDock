---
name: taskdock-collaboration
description: Manage TaskDock projects and Agents or work on tasks through REST API and remote MCP tools. Use when the user asks to create or migrate a TaskDock project or work on its tasks.
---

# Work with TaskDock

Use the TaskDock server URL and Agent API Key configured by the user. Authenticate REST requests and remote MCP requests with `Authorization: Bearer <api-key>`. Never write the Key into a task, comment, artifact, or log.

Read available projects with `GET /api/projects` and tasks with `GET /api/tasks?projectId=<id>`. Read a task with `GET /api/tasks/<id>`; its `version` is required when claiming, releasing, or updating it. Read its context with `GET /api/tasks/<id>/comments`, `/activities`, and `/artifacts`.

Every Agent Key has full REST API permissions. Create a project with `POST /api/projects` and `{ "id": "project-id", "name": "Project name" }`, then create tasks with `POST /api/tasks`. Project management uses `POST /api/projects/<id>/archive`, `POST /api/projects/<id>/restore`, and `DELETE /api/projects/<id>` (empty projects only). Agent management uses `GET` or `POST /api/agents`, `PATCH` or `DELETE /api/agents/<id>`, `POST /api/agents/<id>/keys` to reset a Key, and `DELETE /api/agents/<id>/keys/<key-id>` to revoke one. A newly generated Key appears only once. Use management operations only when the user directs them; keep Keys out of chat and task data.

1. Read the full task and context before changing it. Respect any instruction to wait or leave the task unclaimed.
2. Claim an unclaimed `todo` task with `POST /api/tasks/<id>/claim` and `{ "version": <current version> }`. If another Agent claims it first, refresh the task and leave ownership with that Agent.
3. Update your claimed task with `PATCH /api/tasks/<id>` and the current `version` plus changed fields. Add context with `POST /api/tasks/<id>/comments` and `{ "body": "..." }`.
4. Record durable outputs with `POST /api/tasks/<id>/artifacts` using `type`, `title`, and either `content`, `url`, or `attachmentId`. For a file, upload it to `POST /api/tasks/<id>/attachments` first with a raw body and `X-Taskboard-Filename`, then reference the returned attachment ID.
5. On handoff, comment with the current result and remaining work, then release your claim with `POST /api/tasks/<id>/release` and the current `version`.

The task workflow operations are also available as tools on the remote `/mcp` endpoint. Use REST for project and Agent management. Use the client's Bearer-header configuration for MCP. If an operation fails, report the response instead of changing task ownership indirectly.
