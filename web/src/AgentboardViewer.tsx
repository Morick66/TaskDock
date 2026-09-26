import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  getAgentboardSession,
  listTaskdockAgents,
  loginTaskdock,
  logoutTaskdock,
  listArtifacts,
  listComments,
  listProjects,
  listTaskActivities,
  listTasks,
  resolveTaskboardUrl,
  type TaskdockAgent,
} from "./api";
import { TASK_STATUSES, type ActorIdentity, type Artifact, type Comment, type Project, type Task, type TaskChangeActivity, type TaskStatus } from "./types";
import { TaskboardLanguageProvider, taskStatusLabel } from "./i18n";
import { StatusIcon } from "./components/SemanticIcons";
import { DashboardView } from "./components/DashboardView";
import { TaskdockSettings } from "./TaskdockSettings";
import type { TaskCardPresentation } from "./taskConversations";
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
  const [loginKey, setLoginKey] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<TaskdockAgent[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"dashboard" | "board" | "list" | "settings">("dashboard");
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(() => new Set(["backlog", "done", "canceled"]));

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    return () => { delete document.documentElement.dataset.theme; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void getAgentboardSession(controller.signal).then(
      (result) => setSession(result.authenticated ? "authenticated" : "guest"),
      () => setSession("guest"),
    );
    return () => controller.abort();
  }, []);

  const reload = useCallback(async () => {
    const [nextProjects, nextTasks, nextAgents] = await Promise.all([listProjects(), listTasks(), listTaskdockAgents()]);
    setProjects(nextProjects);
    setTasks(nextTasks);
    setAgents(nextAgents);
    setProjectId((current) => current && nextProjects.find((project) => project.id === current && !project.archivedAt) ? current : null);
    setSelectedTask((current) => nextTasks.find((task) => task.id === current?.id) ?? null);
    setLoadError("");
  }, [session]);

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
      await loginTaskdock(loginKey);
      setLoginKey("");
      setSession("authenticated");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    await logoutTaskdock();
    setSession("guest");
    setView("dashboard");
    setSelectedTask(null);
  }

  if (session === "loading") return <div className="agentboard-login">正在连接 TaskDock…</div>;
  if (session === "guest") {
    return <main className="agentboard-login"><form onSubmit={(event) => void submitLogin(event)}>
      <div className="agentboard-brand">TaskDock</div>
      <h1>登录工作区</h1>
      <p>查看协作进展，并管理项目与 Agent 身份。</p>
      <label htmlFor="taskdock-login-key">登录 Key</label>
      <input id="taskdock-login-key" type="password" autoComplete="current-password" value={loginKey} onChange={(event) => setLoginKey(event.target.value)} required />
      {loginError && <p role="alert" className="agentboard-error">{loginError}</p>}
      <button type="submit" disabled={loginBusy}>{loginBusy ? "登录中…" : "登录"}</button>
    </form></main>;
  }

  const activeProjects = projects.filter((project) => !project.archivedAt);
  const scopedTasks = tasks.filter((task) => activeProjects.some((project) => project.id === task.projectId) && (!projectId || task.projectId === projectId));
  const visibleTasks = scopedTasks.filter((task) => {
    if (projectId && task.projectId !== projectId) return false;
    const needle = search.trim().toLocaleLowerCase();
    return !needle || `${task.identifier} ${task.title} ${task.description}`.toLocaleLowerCase().includes(needle);
  });
  const timeline = detail ? [
    ...detail.comments.map((comment) => ({ id: comment.id, at: comment.createdAt, actor: comment.authorName, label: "评论", body: comment.body })),
    ...detail.activities.map((activity) => ({ id: activity.id, at: activity.createdAt, actor: activity.actorName, label: "操作", body: activitySummary(activity) })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];

  const projectName = projectId ? activeProjects.find((project) => project.id === projectId)?.name ?? "项目" : "所有项目";
  const presentations: Record<string, TaskCardPresentation> = Object.fromEntries(scopedTasks.map((task) => [task.id, { conversations: [], processing: { running: task.status === "in_progress" && Boolean(task.claimedBy), completed: null, total: null, startedAt: null }, unread: false }]));
  const currentUser: ActorIdentity = { type: "user", id: "user", name: "你", avatarUrl: null };
  const dashboardSummary = `当前项目共有 ${scopedTasks.length} 个议题，${scopedTasks.filter((task) => task.status === "done").length} 个已完成，${scopedTasks.filter((task) => task.status === "in_progress").length} 个处理中，${scopedTasks.filter((task) => task.status === "blocked").length} 个阻塞。`;
  const taskCard = (task: Task) => <article key={task.id} className={`task-card status-${task.status} agentboard-readonly-card${selectedTask?.id === task.id ? " selected" : ""}`}>
    <button className="task-card-open" type="button" aria-label={`打开 ${task.identifier}: ${task.title}`} onClick={() => setSelectedTask(task)} />
    <div className="card-topline"><span className="card-reference"><span className="task-identifier">ID: {task.identifier}</span></span></div>
    <h3>{task.title}</h3>
    {task.description && <p className="task-card-description">{task.description}</p>}
    <div className="agentboard-card-footer"><span>{task.claimedBy ? `◉ ${task.claimedBy.name}` : "未认领"}</span>{task.priority !== "none" && <span>{task.priority}</span>}</div>
  </article>;

  return <TaskboardLanguageProvider language="zh"><div className="app-shell agentboard-app"><main className="workspace">
    <header className="workspace-header"><div className="workspace-title"><div className="workspace-kicker"><div className="header-project-switcher">
      <button className="header-project-button" type="button" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}><span className="project-name">{projectName}</span><span aria-hidden="true">⌄</span></button>
      {projectMenuOpen && <div className="header-project-menu agentboard-project-menu" role="menu" aria-label="项目"><span>切换项目</span><div className="project-menu-list">
        <button type="button" role="menuitemradio" aria-checked={!projectId} onClick={() => { setProjectId(null); setProjectMenuOpen(false); }}>▱　所有项目</button>
        {activeProjects.map((project) => <button type="button" role="menuitemradio" aria-checked={projectId === project.id} key={project.id} onClick={() => { setProjectId(project.id); setProjectMenuOpen(false); setView("dashboard"); }}>▱　{project.name}</button>)}
      </div></div>}
    </div></div></div><div className="workspace-drag-region" aria-hidden="true" /><div className="agentboard-header-note">TaskDock</div><button className="taskdock-header-action" type="button" onClick={() => setView("settings")}>设置</button><button className="taskdock-header-action" type="button" onClick={() => void logout()}>退出</button></header>
    <div className="board-toolbar"><div className="view-tabs" aria-label="看板视图">
      <button className={`view-tab${view === "dashboard" ? " active" : ""}`} type="button" onClick={() => setView("dashboard")}>仪表盘</button>
      <button className={`view-tab${view === "board" ? " active" : ""}`} type="button" onClick={() => setView("board")}>议题看板</button>
      <button className={`view-tab${view === "list" ? " active" : ""}`} type="button" onClick={() => setView("list")}>列表视图</button>
      <button className={`view-tab${view === "settings" ? " active" : ""}`} type="button" onClick={() => setView("settings")}>管理设置</button>
    </div><div className="toolbar-tools">{(view === "board" || view === "list") && <div className={`search-field${search ? " has-value" : ""}`}><span className="search-icon">⌕</span><input type="search" aria-label="搜索议题" placeholder="搜索议题…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>}<button className="agentboard-refresh" type="button" onClick={() => void reload().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "刷新失败"))} aria-label="刷新">↻</button></div></div>
    {loadError && <div role="alert" className="agentboard-error">{loadError}</div>}
    {view === "dashboard" && <DashboardView projectId={projectId ?? "all"} projectCreatedAt={projectId ? projects.find((project) => project.id === projectId)?.createdAt ?? null : null} isAllProjects={!projectId} tasks={scopedTasks} presentations={presentations} currentUser={currentUser} animateSummary={false} onSummaryAnimationStart={() => undefined} onOpenTask={setSelectedTask} onOpenConversation={() => undefined} summaryOverride={dashboardSummary} taskdockMode />}
    {view === "settings" && <TaskdockSettings projects={projects} agents={agents} reload={reload} />}
    {view === "board" ? <div className="issue-board-layout agentboard-board-layout" style={{ "--main-column-count": statusOrder.length } as CSSProperties}><div className="board-scroll"><div className="board">
      {statusOrder.map((status: TaskStatus) => { const columnTasks = visibleTasks.filter((task) => task.status === status); return <section key={status} className={`board-column status-${status}`}><header className="column-header"><div className="column-heading"><span className="column-status-icon"><StatusIcon status={status} color="var(--column-status-color)" size={14} /></span><h2>{taskStatusLabel("zh", status)}{columnTasks.length ? ` ${columnTasks.length}` : ""}</h2></div></header><div className="column-list">{columnTasks.map(taskCard)}{columnTasks.length === 0 && <div className="column-empty">暂无议题</div>}</div></section>; })}
    </div></div></div> : view === "list" ? <div className="issue-list-view agentboard-list"><div className="issue-list-groups">{statusOrder.map((status) => { const groupTasks = visibleTasks.filter((task) => task.status === status); const isCollapsed = collapsed.has(status); return <section className={`issue-list-group status-${status}`} key={status}><button className="issue-list-group-header" type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(status)) next.delete(status); else next.add(status); return next; })}><span>{isCollapsed ? "›" : "⌄"}</span><span className="issue-list-status-icon"><StatusIcon status={status} color="currentColor" size={14} /></span><strong>{taskStatusLabel("zh", status)}</strong><span>{groupTasks.length}</span></button>{!isCollapsed && <div className="issue-list-rows">{groupTasks.map((task) => <button className="issue-list-row agentboard-list-row" type="button" key={task.id} onClick={() => setSelectedTask(task)}><span className="issue-list-title-cell"><small>{task.identifier}</small><strong>{task.title}</strong></span><span className="agentboard-list-agent">{task.claimedBy?.name ?? "未认领"}</span><time dateTime={task.updatedAt}>{date(task.updatedAt)}</time></button>)}{groupTasks.length === 0 && <div className="issue-list-empty">暂无议题</div>}</div>}</section>; })}</div></div> : null}
  </main>
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
  </div></TaskboardLanguageProvider>;
}
