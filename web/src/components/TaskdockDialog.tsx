import { useEffect, useRef, type ReactNode } from "react";

export function TaskdockDialog({ children, className, label, labelledBy, onClose }: {
  children: ReactNode; className: string; label?: string; labelledBy?: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    element.showModal();
    element.querySelector<HTMLElement>("[data-dialog-autofocus]")?.focus();
    return () => {
      element.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={dialog} className={className} aria-label={label} aria-labelledby={labelledBy}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}
