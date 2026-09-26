import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  getAgentboardSession,
  listArtifacts,
  listComments,
  listProjects,
  listTaskActivities,
  listTasks,
  loginAgentboard,
  resolveTaskboardUrl,
} from "./api";
import { TASK_STATUSES, type Artifact, type Comment, type Project, type Task, type TaskChangeActivity, type TaskStatus } from "./types";
import { taskStatusLabel } from "./i18n";
import "./AgentboardViewer.css";

type Detail = { comments: Comment[]; activities: TaskChangeActivity[]; artifacts: Artifact[] };

const statusOrder = TASK_STATUSES;

function date(value: string): string {
  return new Date(value).toLocaleString();
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function activitySummary(activity: TaskChangeActivity): string {
  return activity.changes.map((change) => {
    if (change.field === "claim") return change.after ? "认领任务" : "释放任务";
    if (change.field === "artifact") return "提交任务产出";
    if (change.field === "status") return `状态变更为 ${taskStatusLabel("zh", String(change.after) as TaskStatus)}`;
    return `更新 ${change.field}`;
  }).join("、");
}

export function AgentboardViewer() {
  const [session, setSession] = useState<"loading" | "guest" | "authenticated">("loading");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void getAgentboardSession(controller.signal).then(
      (result) => setSession(result.authenticated ? "authenticated" : "guest"),
      () => setSession("guest"),
    );
    return () => controller.abort();
  }, []);

  const reload = useCallback(async () => {
    const [nextProjects, nextTasks] = await Promise.all([listProjects(), listTasks()]);
    setProjects(nextProjects);
    setTasks(nextTasks);
    setSelectedTask((current) => nextTasks.find((task) => task.id === current?.id) ?? null);
    setLoadError("");
  }, []);

  useEffect(() => {
    if (session !== "authenticated") return;
    void reload().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "无法读取看板"));
    const interval = window.setInterval(() => {
      void reload().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "无法读取看板"));
    }, 15000);
    return () => window.clearInterval(interval);
  }, [session, reload]);

  useEffect(() => {
    if (!selectedTask) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    void Promise.all([
      listComments(selectedTask.id, controller.signal),
      listTaskActivities(selectedTask.id, controller.signal),
      listArtifacts(selectedTask.id, controller.signal),
    ]).then(
      ([comments, activities, artifacts]) => setDetail({ comments, activities, artifacts }),
      (error: unknown) => {
        if ((error as Error).name !== "AbortError") setLoadError(error instanceof Error ? error.message : "无法读取任务详情");
      },
    );
    return () => controller.abort();
  }, [selectedTask?.id, selectedTask?.activityKey]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      await loginAgentboard(password);
      setPassword("");
      setSession("authenticated");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  if (session === "loading") return <div className="agentboard-login">正在连接 AgentBoard…</div>;
  if (session === "guest") {
    return <main className="agentboard-login"><form onSubmit={(event) => void submitLogin(event)}>
      <div className="agentboard-brand">AgentBoard</div>
      <h1>查看协作看板</h1>
      <p>输入查看密码，了解 Agent 的任务进展和交付结果。</p>
      <label htmlFor="agentboard-password">查看密码</label>
      <input id="agentboard-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      {loginError && <p role="alert" className="agentboard-error">{loginError}</p>}
      <button type="submit" disabled={loginBusy}>{loginBusy ? "登录中…" : "登录"}</button>
    </form></main>;
  }

  const visibleTasks = projectId ? tasks.filter((task) => task.projectId === projectId) : tasks;
  const timeline = detail ? [
    ...detail.comments.map((comment) => ({ id: comment.id, at: comment.createdAt, actor: comment.authorName, label: "评论", body: comment.body })),
    ...detail.activities.map((activity) => ({ id: activity.id, at: activity.createdAt, actor: activity.actorName, label: "操作", body: activitySummary(activity) })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];

  return <div className="agentboard-app">
    <header className="agentboard-header"><div><strong>AgentBoard</strong><span>多 Agent 协作看板</span></div><button type="button" onClick={() => void reload().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "刷新失败"))}>刷新</button></header>
    <div className="agentboard-layout">
      <aside className="agentboard-sidebar"><div className="agentboard-sidebar-title">项目</div>
        <button type="button" className={projectId === null ? "active" : ""} onClick={() => setProjectId(null)}>全部项目 <span>{tasks.length}</span></button>
        {projects.map((project) => <button type="button" key={project.id} className={projectId === project.id ? "active" : ""} onClick={() => setProjectId(project.id)}>{project.name}<span>{tasks.filter((task) => task.projectId === project.id).length}</span></button>)}
      </aside>
      <main className="agentboard-main">
        <div className="agentboard-heading"><h1>{projectId ? projects.find((project) => project.id === projectId)?.name ?? "项目" : "全部任务"}</h1><span>{visibleTasks.length} 个任务</span></div>
        {loadError && <div role="alert" className="agentboard-error">{loadError}</div>}
        <div className="agentboard-board">{statusOrder.map((status: TaskStatus) => {
          const columnTasks = visibleTasks.filter((task) => task.status === status);
          return <section key={status} className={`agentboard-column status-${status}`}><h2>{taskStatusLabel("zh", status)} <span>{columnTasks.length}</span></h2>
            <div className="agentboard-cards">{columnTasks.map((task) => <button type="button" key={task.id} className={`agentboard-card${selectedTask?.id === task.id ? " selected" : ""}`} onClick={() => setSelectedTask(task)}>
              <span className="agentboard-identifier">{task.identifier}</span><strong>{task.title}</strong>
              <span className="agentboard-claim">{task.claimedBy ? `认领：${task.claimedBy.name}` : "未认领"}</span>
            </button>)}</div>
          </section>;
        })}</div>
      </main>
    </div>
    {selectedTask && <div className="agentboard-detail-backdrop" onClick={() => setSelectedTask(null)}><aside className="agentboard-detail" onClick={(event) => event.stopPropagation()} aria-label="任务详情">
      <div className="agentboard-detail-head"><span>{selectedTask.identifier}</span><button type="button" onClick={() => setSelectedTask(null)} aria-label="关闭详情">×</button></div>
      <h2>{selectedTask.title}</h2><div className="agentboard-properties"><span>状态：{taskStatusLabel("zh", selectedTask.status)}</span><span>认领 Agent：{selectedTask.claimedBy?.name ?? "未认领"}</span></div>
      <section><h3>描述</h3><p className="agentboard-body">{selectedTask.description || "暂无描述"}</p></section>
      <section><h3>任务产出</h3>{!detail ? <p>加载中…</p> : detail.artifacts.length === 0 ? <p>暂无产出</p> : detail.artifacts.map((artifact) => {
        const href = artifact.attachmentId ? resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(artifact.attachmentId)}/download`) : safeUrl(artifact.url);
        return <article key={artifact.id} className="agentboard-artifact"><div><strong>{artifact.title}</strong><small>{artifact.type} · {artifact.agentName} · {date(artifact.createdAt)}</small></div>{artifact.content && <p className="agentboard-body">{artifact.content}</p>}{href && <a href={href} target="_blank" rel="noopener noreferrer">查看产出 ↗</a>}</article>;
      })}</section>
      <section><h3>操作历史与评论</h3>{!detail ? <p>加载中…</p> : timeline.length === 0 ? <p>暂无记录</p> : timeline.map((item) => <article className="agentboard-event" key={`${item.label}-${item.id}`}><small>{date(item.at)}</small><div><strong>{item.actor}</strong> · {item.label}</div><p className="agentboard-body">{item.body}</p></article>)}</section>
    </aside></div>}
  </div>;
}
