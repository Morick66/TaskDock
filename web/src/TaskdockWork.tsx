import { useEffect, useRef, useState, type FormEvent } from "react";
import { createComment, getTask, listArtifacts, listAttachments, listComments, saveChecklistItem, updateTask, uploadAttachment, resolveTaskboardUrl } from "./api";
import type { Artifact, Attachment, ChecklistItem, Comment, Task } from "./types";
import { MarkdownDocument } from "./components/MarkdownDocument";
import { taskStatusLabel } from "./i18n";
import "./TaskdockWork.css";

export const taskExecutor = (task: Task) => task.executor ?? task.assignee.type;
const active = (task: Task) => !["done", "canceled"].includes(task.status) && !task.archivedAt;
const pendingUserItems = (task: Task) => (task.checklist ?? []).filter((item) => item.executor === "user" && item.status !== "done");
export const needsUser = (task: Task) => active(task) && (taskExecutor(task) === "user" || pendingUserItems(task).length > 0);

export function WorkAttachments({ attachments }: { attachments: Attachment[] }) {
  return <ul className="agentboard-attachments">{attachments.map((attachment) => <li key={attachment.id}>
    <span>{attachment.filename}<small>{Math.ceil(attachment.size / 1024)} KB</small></span>
    <a href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(attachment.id)}/content`)} target="_blank" rel="noopener noreferrer">查看</a>
    <a href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(attachment.id)}/download`)} download={attachment.filename}>下载</a>
  </li>)}</ul>;
}

function ChecklistRow({ item, busy, attachments, onSave, onUpload, onRemove }: {
  item: ChecklistItem; busy: boolean; attachments: Attachment[];
  onSave: (changes: Partial<ChecklistItem>) => Promise<void>;
  onUpload: (file: File) => Promise<void>; onRemove: () => Promise<void>;
}) {
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const titleDirty = useRef(false);
  const noteDirty = useRef(false);
  useEffect(() => { if (!titleDirty.current) setTitle(item.title); }, [item.title]);
  useEffect(() => { if (!noteDirty.current) setNote(item.note); }, [item.note]);
  return <div className={`taskdock-checklist-row is-${item.status}`} aria-busy={busy}>
    <div className="taskdock-checklist-line">
      <label className="taskdock-check-control"><input type="checkbox" aria-label={`完成：${item.title}`} checked={item.status === "done"} disabled={busy} onChange={(event) => void onSave({ status: event.target.checked ? "done" : "pending" })} /></label>
      <span className="taskdock-check-title">{item.title}</span>
      <span className="taskdock-executor">{item.executor === "user" ? "我做" : "Agent 做"}</span>
      <span className={`taskdock-result is-${item.status}`}>{item.status === "done" ? "已完成" : item.status === "issue" ? "有问题" : item.ready ? "未完成" : "尚未就绪"}</span>
    </div>
    {item.note && <div className="taskdock-check-note"><MarkdownDocument value={item.note} /></div>}
    <WorkAttachments attachments={attachments.filter((attachment) => item.attachmentIds.includes(attachment.id))} />
    <details className="taskdock-item-editor"><summary>备注、素材与编辑</summary>
      <label>事项<input value={title} onChange={(event) => { titleDirty.current = true; setTitle(event.target.value); }} onBlur={() => {
        if (title.trim() && title !== item.title) void onSave({ title }).then(() => { titleDirty.current = false; });
      }} disabled={busy} /></label>
      <div className="taskdock-form-row">
        <label>执行者<select value={item.executor} disabled={busy} onChange={(event) => void onSave({ executor: event.target.value as ChecklistItem["executor"] })}><option value="user">我做</option><option value="agent">Agent 做</option></select></label>
        <label>结果<select aria-label={`结果：${item.title}`} value={item.status} disabled={busy} onChange={(event) => void onSave({ status: event.target.value as ChecklistItem["status"] })}><option value="pending">未完成</option><option value="done">已完成</option><option value="issue">有问题</option></select></label>
      </div>
      <label className="taskdock-ready"><input type="checkbox" checked={item.ready} disabled={busy} onChange={(event) => void onSave({ ready: event.target.checked })} />现在可以开始</label>
      <label>操作说明、测试反馈或素材位置<textarea rows={3} value={note} onChange={(event) => { noteDirty.current = true; setNote(event.target.value); }} onBlur={() => {
        if (note !== item.note) void onSave({ note }).then(() => { noteDirty.current = false; });
      }} placeholder="离开输入框时自动保存；支持 Markdown" disabled={busy} /></label>
      <div className="taskdock-work-actions"><label className="taskdock-upload">添加素材<input type="file" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUpload(file); event.target.value = ""; }} /></label><button type="button" disabled={busy} onClick={() => void onRemove()}>删除此项</button></div>
    </details>
  </div>;
}

export function TaskdockWork({ task, onChanged, userOnly = false }: { task: Task; onChanged: (task: Task) => void; userOnly?: boolean }) {
  const latestTask = useRef(task);
  latestTask.current = task;
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [executor, setExecutor] = useState<ChecklistItem["executor"]>("user");
  const [ready, setReady] = useState(true);
  const [remark, setRemark] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([listAttachments(task.id, controller.signal), listComments(task.id, controller.signal), listArtifacts(task.id, controller.signal)]).then(
      ([files, notes, outputs]) => { setAttachments(files); setComments(notes); setArtifacts(outputs); },
      (cause: Error) => { if (cause.name !== "AbortError") setError(cause.message); },
    );
    return () => controller.abort();
  }, [task.id, task.activityKey]);

  async function run(action: () => Promise<Task | void>) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(""); setMessage("保存中…");
    try {
      const next = await action();
      const saved = next ?? await getTask(task.id);
      latestTask.current = saved;
      onChanged(saved);
      setMessage("已保存到任务与操作历史");
    } catch (cause) {
      setMessage(""); setError(cause instanceof Error ? cause.message : "保存失败");
    } finally { saving.current = false; setBusy(false); }
  }
  const save = (item: ChecklistItem, changes: Partial<ChecklistItem>) => run(() => saveChecklistItem(latestTask.current, item.id, changes));
  async function addItem(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const next = await saveChecklistItem(latestTask.current, null, { title, executor, ready });
      setTitle(""); return next;
    });
  }
  const items = (task.checklist ?? []).filter((item) => !userOnly || item.executor === "user");
  const current = items.filter((item) => item.ready && item.status !== "done");
  const later = items.filter((item) => !item.ready && item.status !== "done");
  const done = items.filter((item) => item.status === "done");
  const row = (item: ChecklistItem) => <ChecklistRow key={item.id} item={item} busy={busy} attachments={attachments} onSave={(changes) => save(item, changes)} onRemove={() => run(() => saveChecklistItem(latestTask.current, item.id, {}, true))} onUpload={(file) => run(async () => {
    const attachment = await uploadAttachment(task.id, file, "attachment");
    return saveChecklistItem(latestTask.current, item.id, { attachmentIds: [...item.attachmentIds, attachment.id] });
  })} />;

  return <div className="taskdock-work">
    <div className="taskdock-work-heading"><div><h3>{userOnly ? "需要我完成" : "任务清单"}</h3><p>{done.length}/{items.length} 已完成 · 勾选不会自动验收任务</p></div><span role="status" className="taskdock-save-state">{message}</span></div>
    {error && <p className="agentboard-error" role="alert">{error}</p>}
    <div className="taskdock-checklist">{current.map(row)}{items.length === 0 && <p className="taskdock-muted">添加测试项、素材准备或其他执行步骤。</p>}</div>
    {later.length > 0 && <details className="taskdock-check-group"><summary>后续需要{userOnly ? "我" : "处理"} · {later.length}</summary>{later.map(row)}</details>}
    {done.length > 0 && <details className="taskdock-check-group"><summary>已完成 · {done.length}</summary>{done.map(row)}</details>}
    <form className="taskdock-add-item" onSubmit={(event) => void addItem(event)}>
      <label>添加清单项<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：试玩角色切换，确认待命状态保留" maxLength={1000} required disabled={busy} /></label>
      <div className="taskdock-work-actions"><label>执行者<select value={executor} onChange={(event) => setExecutor(event.target.value as ChecklistItem["executor"])} disabled={busy}><option value="user">我做</option><option value="agent">Agent 做</option></select></label><label className="taskdock-ready"><input type="checkbox" checked={ready} onChange={(event) => setReady(event.target.checked)} disabled={busy} />现在可以开始</label><button type="submit" disabled={busy || !title.trim()}>添加</button></div>
    </form>
    <details className="taskdock-context" open={userOnly || undefined}><summary>反馈与素材</summary>
      {comments.slice(-3).map((comment) => <article className="taskdock-remark" key={comment.id}><small>{comment.authorName} · {new Date(comment.createdAt).toLocaleString()}</small><MarkdownDocument value={comment.body} /></article>)}
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await createComment(task.id, remark); setRemark(""); }); }}>
        <label>任务备注<textarea value={remark} onChange={(event) => setRemark(event.target.value)} rows={3} placeholder="记录测试现象、准备进度或素材所在路径" disabled={busy} /></label>
        <div className="taskdock-work-actions"><button type="submit" disabled={busy || !remark.trim()}>添加备注</button><label className="taskdock-upload">上传任务素材<input type="file" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void run(async () => { await uploadAttachment(task.id, file, "attachment"); }); event.target.value = ""; }} /></label></div>
      </form>
      <WorkAttachments attachments={attachments} />
    </details>
    {userOnly && <details className="taskdock-context"><summary>任务说明与 Agent 产出</summary><MarkdownDocument value={task.description || "暂无说明"} />{artifacts.map((artifact) => <article className="agentboard-artifact" key={artifact.id}><strong>{artifact.title}</strong>{artifact.content && <MarkdownDocument value={artifact.content} />}{artifact.attachmentId ? <a href={resolveTaskboardUrl(`/api/attachments/${encodeURIComponent(artifact.attachmentId)}/download`)}>下载产出</a> : artifact.url && /^https?:\/\//.test(artifact.url) ? <a href={artifact.url} target="_blank" rel="noopener noreferrer">查看产出</a> : null}</article>)}</details>}
  </div>;
}

function PersonalTask({ task, onChanged, onOpen }: { task: Task; onChanged: (task: Task) => void; onOpen: (task: Task) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function changeStatus(status: Task["status"]) {
    setBusy(true); setError("");
    try { onChanged(await updateTask(task, { title: task.title, description: task.description, status, priority: task.priority, labels: task.labels, developmentContext: task.developmentContext, startDate: task.startDate, dueDate: task.dueDate, recurrence: task.recurrence })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败"); }
    finally { setBusy(false); }
  }
  return <article className="taskdock-personal-task">
    <header><div><small>{task.identifier} · {taskExecutor(task) === "user" ? "我负责" : "Agent 负责"}</small><h2>{task.title}</h2></div><button type="button" onClick={() => onOpen(task)}>打开完整任务</button></header>
    {taskExecutor(task) === "user" && <label className="taskdock-personal-status">任务状态<select aria-label={`${task.identifier} 任务状态`} value={task.status} disabled={busy} onChange={(event) => void changeStatus(event.target.value as Task["status"])}>{["backlog", "todo", "in_progress", "in_review", "done", "blocked", "canceled"].map((status) => <option key={status} value={status}>{status === "todo" ? "待办" : taskStatusLabel("zh", status as Task["status"])}</option>)}</select></label>}
    {error && <p role="alert" className="agentboard-error">{error}</p>}
    <TaskdockWork task={task} onChanged={onChanged} userOnly />
  </article>;
}

export function TaskdockPersonalView({ tasks, onChanged, onOpen }: { tasks: Task[]; onChanged: (task: Task) => void; onOpen: (task: Task) => void }) {
  const priorities = ["urgent", "high", "medium", "low", "none"];
  const mine = tasks.filter(needsUser).sort((a, b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority) || a.updatedAt.localeCompare(b.updatedAt));
  const ready = mine.filter((task) => taskExecutor(task) === "user" ? !["backlog", "blocked"].includes(task.status) : pendingUserItems(task).some((item) => item.ready));
  const later = mine.filter((task) => !ready.includes(task));
  return <div className="taskdock-personal-view"><div className="taskdock-personal-heading"><h2>等我处理 <span>{ready.length}</span></h2><p>完成自己的事项，记录反馈和素材。Agent 会在你安排它工作时读取最新进展。</p></div>
    {ready.length === 0 && <div className="taskdock-personal-empty">当前没有需要你处理的事项。</div>}
    {ready.map((task) => <PersonalTask key={task.id} task={task} onChanged={onChanged} onOpen={onOpen} />)}
    {later.length > 0 && <details className="taskdock-personal-later"><summary>后续需要我 · {later.length} 个任务</summary>{later.map((task) => <PersonalTask key={task.id} task={task} onChanged={onChanged} onOpen={onOpen} />)}</details>}
  </div>;
}
