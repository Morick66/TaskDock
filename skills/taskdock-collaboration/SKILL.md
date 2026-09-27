---
name: taskdock-collaboration
description: Work on tasks in a TaskDock project through its REST API or remote MCP tools, including claiming, progress updates, handoff, and artifact submission. Use when the user provides a TaskDock project as the work target.
---

# Work with TaskDock

Use the TaskDock server URL and Agent API Key configured by the user. Authenticate REST requests and remote MCP requests with `Authorization: Bearer <api-key>`. Never write the Key into a task, comment, artifact, or log.

Read available projects with `GET /api/projects` and tasks with `GET /api/tasks?projectId=<id>`. Read a task with `GET /api/tasks/<id>`; its `version` is required when claiming, releasing, or updating it. Read its context with `GET /api/tasks/<id>/comments`, `/activities`, and `/artifacts`.

An Agent Key may create a project with `POST /api/projects` and `{ "id": "project-id", "name": "Project name" }`, then create tasks in it with `POST /api/tasks`. Create a project only when the user asks for one, such as when migrating an existing project. The user Key is not needed for these operations.

1. Read the full task and context before changing it. Respect any instruction to wait or leave the task unclaimed.
2. Claim an unclaimed `todo` task with `POST /api/tasks/<id>/claim` and `{ "version": <current version> }`. If another Agent claims it first, refresh the task and leave ownership with that Agent.
3. Update your claimed task with `PATCH /api/tasks/<id>` and the current `version` plus changed fields. Add context with `POST /api/tasks/<id>/comments` and `{ "body": "..." }`.
4. Record durable outputs with `POST /api/tasks/<id>/artifacts` using `type`, `title`, and either `content`, `url`, or `attachmentId`. For a file, upload it to `POST /api/tasks/<id>/attachments` first with a raw body and `X-Taskboard-Filename`, then reference the returned attachment ID.
5. On handoff, comment with the current result and remaining work, then release your claim with `POST /api/tasks/<id>/release` and the current `version`.

The same operations are available as tools on the remote `/mcp` endpoint. Use the client's Bearer-header configuration. If an operation or authorization is unavailable, report the blocker instead of changing task ownership indirectly.
