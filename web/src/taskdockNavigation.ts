import { useCallback, useEffect, useState } from "react";
import { TASK_STATUSES, type TaskStatus } from "./types";

const views = ["dashboard", "board", "list", "readme", "settings", "personal"] as const;
export type TaskdockView = (typeof views)[number];
export type DetailSection = "description" | "checklist" | "artifacts" | "history";
export type TaskdockFilter = TaskStatus | "overdue" | null;
type Route = { projectId: string | null; view: TaskdockView; taskId: string | null; section: DetailSection; status: TaskdockFilter };

function readRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const status = params.get("status");
  const section = params.get("section");
  return {
    projectId: params.get("project"),
    view: views.includes(view as TaskdockView) ? view as TaskdockView : "dashboard",
    taskId: params.get("task"),
    section: ["checklist", "artifacts", "history"].includes(section ?? "") ? section as DetailSection : "description",
    status: status === "overdue" || TASK_STATUSES.includes(status as TaskStatus) ? status as TaskdockFilter : null,
  };
}

export function useTaskdockNavigation() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const restore = () => setRoute(readRoute());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const navigate = useCallback((changes: Partial<Route>, replace = false) => {
    const next = { ...route, ...changes };
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ project: next.projectId, view: next.view === "dashboard" ? null : next.view, task: next.taskId, section: next.taskId && next.section !== "description" ? next.section : null, status: next.status })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    if (url.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"](null, "", url);
    setRoute(next);
  }, [route]);
  return { ...route, navigate };
}
