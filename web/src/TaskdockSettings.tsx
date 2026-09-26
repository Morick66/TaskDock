import { useState, type FormEvent } from "react";
import {
  archiveTaskdockProject, createProject, createTaskdockAgent, deleteProject,
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
  const [agentProjects, setAgentProjects] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<{ agent: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const activeProjects = projects.filter((project) => !project.archivedAt);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setBusy(false); }
  }

  function toggleProject(id: string) {
    setAgentProjects((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  function startEdit(agent: TaskdockAgent) {
    setEditing(agent.id);
    setAgentId(agent.id);
    setAgentName(agent.name);
    setAgentProjects(agent.projectIds.filter((id) => activeProjects.some((project) => project.id === id)));
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
      const input = { id: agentId.trim(), name: agentName.trim(), projectIds: agentProjects };
      if (editing) await updateTaskdockAgent(input);
      else await createTaskdockAgent(input);
      setEditing(null); setAgentId(""); setAgentName(""); setAgentProjects([]);
      setNotice(editing ? "Agent 已更新" : "Agent 已创建，可以颁发 API Key");
    });
  }

  return <div className="taskdock-settings">
    <header className="taskdock-settings-heading"><div><span>工作区管理</span><h1>项目与 Agent</h1><p>在这里配置项目和身份。Agent 通过 API Key 使用 REST 或 MCP 协作。</p></div></header>
    {error && <div className="agentboard-error" role="alert">{error}</div>}
    {notice && <div className="taskdock-notice" role="status">{notice}</div>}
    <div className="taskdock-settings-grid">
      <section className="taskdock-settings-panel"><div className="taskdock-panel-title"><h2>项目</h2><span>{activeProjects.length} 个活跃</span></div>
        <form className="taskdock-form" onSubmit={(event) => void submitProject(event)}>
          <div className="taskdock-form-row"><label>项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：官网改版" required /></label><label>项目 ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="website" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /></label></div>
          <button type="submit" disabled={busy}>创建项目</button>
        </form>
        <div className="taskdock-settings-list">{projects.map((project) => <div className="taskdock-settings-item" key={project.id}><div><strong>{project.name}</strong><small>{project.id} · {project.archivedAt ? "已归档" : "活跃"}</small></div><div className="taskdock-item-actions">{project.id !== "local" && <><button type="button" disabled={busy} onClick={() => void run(async () => { if (project.archivedAt) await restoreTaskdockProject(project.id); else await archiveTaskdockProject(project.id); setNotice(project.archivedAt ? "项目已恢复" : "项目已归档"); })}>{project.archivedAt ? "恢复" : "归档"}</button><button type="button" disabled={busy} onClick={() => { if (window.confirm(`删除空项目「${project.name}」？此操作无法撤销。`)) void run(async () => { await deleteProject(project.id); setNotice("项目已删除"); }); }}>删除</button></>}</div></div>)}</div>
      </section>
      <section className="taskdock-settings-panel"><div className="taskdock-panel-title"><h2>Agent 身份</h2><span>{agents.length} 个</span></div>
        <form className="taskdock-form" onSubmit={(event) => void submitAgent(event)}>
          <div className="taskdock-form-row"><label>Agent 名称<input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="例如：Claude" required /></label><label>Agent ID<input value={agentId} disabled={Boolean(editing)} onChange={(event) => setAgentId(event.target.value)} placeholder="claude" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" required /></label></div>
          <fieldset><legend>可访问的项目</legend><div className="taskdock-project-checks">{activeProjects.map((project) => <label key={project.id}><input type="checkbox" checked={agentProjects.includes(project.id)} onChange={() => toggleProject(project.id)} />{project.name}</label>)}</div></fieldset>
          <div className="taskdock-form-actions"><button type="submit" disabled={busy || agentProjects.length === 0}>{editing ? "保存 Agent" : "创建 Agent"}</button>{editing && <button type="button" className="taskdock-secondary" onClick={() => { setEditing(null); setAgentId(""); setAgentName(""); setAgentProjects([]); }}>取消编辑</button>}</div>
        </form>
        {issuedKey && <div className="taskdock-issued-key" role="status"><strong>{issuedKey.agent} 的新 API Key</strong><p>请现在复制保存；离开此页后无法再次查看。</p><code>{issuedKey.key}</code><button type="button" onClick={() => void navigator.clipboard.writeText(issuedKey.key)}>复制 Key</button></div>}
        <div className="taskdock-settings-list">{agents.map((agent) => <div className="taskdock-agent-item" key={agent.id}><div className="taskdock-agent-heading"><div><strong>{agent.name}</strong><small>{agent.id} · {agent.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? id).join("、") || "未授权项目"}</small></div><div className="taskdock-item-actions"><button type="button" onClick={() => startEdit(agent)}>编辑</button><button type="button" disabled={busy} onClick={() => void run(async () => { const result = await issueTaskdockKey(agent.id); setIssuedKey({ agent: agent.name, key: result.key }); })}>创建 Key</button></div></div>{agent.keys.filter((key) => !key.revokedAt).map((key) => <div className="taskdock-key-row" key={key.id}><span>Key {key.id.slice(0, 8)} · {new Date(key.createdAt).toLocaleDateString()}</span><button type="button" disabled={busy} onClick={() => { if (window.confirm(`撤销 ${agent.name} 的这个 API Key？`)) void run(async () => { await revokeTaskdockKey(agent.id, key.id); setNotice("Key 已撤销"); }); }}>撤销</button></div>)}</div>)}</div>
      </section>
    </div>
  </div>;
}
