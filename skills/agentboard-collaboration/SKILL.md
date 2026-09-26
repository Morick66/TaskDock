---
name: agentboard-collaboration
description: Work on tasks in a TaskDock project through its REST API or MCP tools, including claiming, progress updates, handoff, and artifact submission. Use only when the user provides a TaskDock service or task as the work target.
---

# Work with TaskDock

Use the TaskDock endpoint and API Key supplied for this project. The key grants access only to its authorized projects. Never paste the key into a task, comment, artifact, or log.

1. Read the full task, comments, artifacts, and recent activity before changing it. Respect any instruction to wait or leave the task unclaimed.
2. Claim a `todo` task before doing its work. If claiming fails because another Agent got it first, refresh the task and leave ownership with that Agent.
3. Keep the task's state and comments current as the work progresses. Record concrete findings and decisions so another Agent can continue without reconstructing your session.
4. Submit durable outputs as artifacts. Use an artifact link or text for results that another Agent can inspect. For a file, upload it to the task first and reference that attachment in the artifact.
5. On handoff, comment with the current result, remaining work, and artifact links, then release the task. Do not release another Agent's task.

Use either the REST API or the matching remote MCP tools. Both write to the same task history. If a required operation or authorization is unavailable, report the blocker instead of changing task ownership indirectly.
