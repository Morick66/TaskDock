import { useState, type FormEvent } from "react";
import {
  archiveTaskdockProject, createProject, createTaskdockAgent, deleteProject, deleteTaskdockAgent,
  issueTaskdockKey, restoreTaskdockProject, revokeTaskdockKey, updateTaskdockAgent,
  type TaskdockAgent,
} from "./api";
import type { Project } from "./types";

interface Props {
  projects: Project[];
  agents: TaskdockAgent[];
  reload: () => Promise<void>;
}

export function TaskdockSettings({ projects, agents, reload }: Props) {
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<{ agent: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [installCopied, setInstallCopied] = useState(false);
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const serverUrl = window.location.origin;
  const installPrompt = `请安装 TaskDock 协作 Skill，并在我指定的项目任务中使用它。\n\nSkill 文件：${serverUrl}/skills/taskdock-collaboration/SKILL.md\nTaskDock API 地址：${serverUrl}\n远程 MCP 地址：${serverUrl}/mcp\n\n请下载 SKILL.md，按你当前 Agent 客户端的 Skill 安装方式保存为 taskdock-collaboration/SKILL.md 并启用。如果客户端不支持安装 Skill，请先阅读该文件并遵循其中的协作流程。\n\nAPI Key 由我自行在你的凭据或环境配置中设置，不会放在这段文字里。使用 REST 或 MCP 时以 Authorization: Bearer <API Key> 认证。不要把 Key 写入聊天、Skill 文件、任务、评论或日志。配置完成后，先只读调用 GET /api/projects 验证连接，再等待我指定任务。`;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  }

  function startEdit(agent: TaskdockAgent) {
    setEditing(agent.id);
    setAgentId(agent.id);
    setAgentName(agent.name);
    setIssuedKey(null);
  }

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      await createProject({ id: projectId.trim(), name: projectName.trim(), workspacePath: null });
      setProjectId(""); setProjectName(""); setNotice("项目已创建");
    });
  }

  async function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const input = { id: agentId.trim(), name: agentName.trim() };
      if (editing) await updateTaskdockAgent(input);
      else {
        const result = await createTaskdockAgent(input);
        setIssuedKey({ agent: result.agent.name, key: result.key });
      }
      setEditing(null); setAgentId(""); setAgentName("");
      setNotice(editing ? "Agent 已更新" : "Agent 与 API Key 已创建");
    });
  }

  async function copyInstallPrompt() {
    try { await navigator.clipboard.writeText(installPrompt); setInstallCopied(true); }
    catch { setError("复制失败，请手动选择下面的文字复制"); }
  }

  return <div className="taskdock-settings">
    <header className="taskdock-settings-heading"><p>管理项目和 Agent 身份。每个 Agent 使用一个 API Key，可通过 API 管理所有项目、任务和 Agent。</p></header>
    {error && <div className="agentboard-error" role="alert">{error}</div>}
    {notice && <div className="taskdock-notice" role="status">{notice}</div>}
    <div className="taskdock-settings-grid">
      <section className="taskdock-settings-panel"><div className="taskdock-panel-title"><h2>项目</h2><span>{activeProjects.filter((project) => project.id !== "local" || project.issueCount > 0).length} 个活跃</span></div>
        <form className="taskdock-form" onSubmit={(event) => void submitProject(event)}>
          <div className="taskdock-form-row"><label>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：官网改版" required /></label><label>项目 ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="website" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /></label></div>
          <button type="submit" disabled={busy}>创建项目</button>
        </form>
        <div className="taskdock-settings-list">{projects.filter((project) => project.id !== "local" || project.issueCount > 0).map((project) => <div className="taskdock-settings-item" key={project.id}><div><strong>{project.id === "local" ? "未分类任务" : project.name}</strong><small>{project.id} · {project.archivedAt ? "已归档" : "活跃"}</small></div><div className="taskdock-item-actions">{project.id !== "local" && <><button type="button" disabled={busy} onClick={() => void run(async () => { if (project.archivedAt) await restoreTaskdockProject(project.id); else await archiveTaskdockProject(project.id); setNotice(project.archivedAt ? "项目已恢复" : "项目已归档"); })}>{project.archivedAt ? "恢复" : "归档"}</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`删除空项目「${project.name}」？此操作无法撤销。`)) void run(async () => { await deleteProject(project.id); setNotice("项目已删除"); }); }}>删除</button></>}</div></div>)}</div>
      </section>
      <section className="taskdock-settings-panel"><div className="taskdock-panel-title"><h2>Agent 身份</h2><span>{agents.length} 个</span></div>
        <form className="taskdock-form" onSubmit={(event) => void submitAgent(event)}>
          <div className="taskdock-form-row"><label>Agent 名称<input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="例如：Claude" required /></label><label>Agent ID<input value={agentId} disabled={Boolean(editing)} onChange={(event) => setAgentId(event.target.value)} placeholder="claude" pattern="[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?" required /></label></div>
          <div className="taskdock-form-actions"><button type="submit" disabled={busy}>{editing ? "保存 Agent" : "创建 Agent 并生成 Key"}</button>{editing && <button type="button" className="taskdock-secondary" onClick={() => { setEditing(null); setAgentId(""); setAgentName(""); }}>取消编辑</button>}</div>
        </form>
        {issuedKey && <div className="taskdock-issued-key" role="status"><strong>{issuedKey.agent} 的新 API Key</strong><p>请现在复制保存；离开此页后无法再次查看。</p><code>{issuedKey.key}</code><button type="button" onClick={() => void navigator.clipboard.writeText(issuedKey.key)}>复制 Key</button></div>}
        <div className="taskdock-settings-list">{agents.map((agent) => <div className="taskdock-agent-item" key={agent.id}><div className="taskdock-agent-heading"><div><strong>{agent.name}</strong><small>{agent.id} · 所有项目</small></div><div className="taskdock-item-actions"><button type="button" onClick={() => startEdit(agent)}>编辑</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`重置 ${agent.name} 的 API Key？原 Key 会立即失效。`)) void run(async () => { const result = await issueTaskdockKey(agent.id); setIssuedKey({ agent: agent.name, key: result.key }); }); }}>重置 Key</button><button type="button" className="taskdock-danger" disabled={busy} onClick={() => { if (window.confirm(`删除 Agent「${agent.name}」及其 API Key？它认领的任务将回到待办，历史记录保留。`)) void run(async () => { await deleteTaskdockAgent(agent.id); if (editing === agent.id) { setEditing(null); setAgentId(""); setAgentName(""); } setIssuedKey(null); setNotice("Agent 和 API Key 已删除"); }); }}>删除</button></div></div>{agent.keys.filter((key) => !key.revokedAt).map((key) => <div className="taskdock-key-row" key={key.id}><span>当前 Key · {new Date(key.createdAt).toLocaleDateString()}</span><button type="button" disabled={busy} onClick={() => { if (window.confirm(`撤销 ${agent.name} 的 API Key？`)) void run(async () => { await revokeTaskdockKey(agent.id, key.id); setNotice("Key 已撤销"); }); }}>撤销</button></div>)}</div>)}</div>
      </section>
    </div>
    <details className="taskdock-onboarding"><summary>Agent 接入说明 <span>Skill · REST API · MCP</span></summary><div className="taskdock-onboarding-content"><div className="taskdock-onboarding-head"><p>复制这段文字发给 Agent，让它安装 Skill。API Key 由你在 Agent 环境中设置。</p><button type="button" onClick={() => void copyInstallPrompt()}>{installCopied ? "已复制" : "复制给 Agent"}</button></div><textarea aria-label="发给 Agent 的 Skill 安装说明" readOnly value={installPrompt} rows={10} /><a href={`${serverUrl}/skills/taskdock-collaboration/SKILL.md`} target="_blank" rel="noopener noreferrer">查看 Skill 文件 ↗</a></div></details>
  </div>;
}
