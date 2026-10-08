"use client";

import { useEffect, useRef } from "react";
import { Icon } from "./icon";
export function Dialog({
  title,
  children,
  close,
  drawer = false,
  busy = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  drawer?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? "dialog drawer" : "dialog"}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="dialog-content">
        <header className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
