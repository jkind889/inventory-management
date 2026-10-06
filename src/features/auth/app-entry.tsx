"use client";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Brand } from "@/components/icon";
import { getBrowserClient } from "@/lib/supabase-browser";
import { AuthScreen } from "./auth-screen";
import { CollectionScreen } from "@/features/collection/collection-screen";
export function AppEntry() {
  const [state, setState] = useState<{
    ready: boolean;
    session: Session | null;
    recovery: boolean;
    error?: string;
  }>({ ready: false, session: null, recovery: false });
  useEffect(() => {
    let active = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const linkError = hash.has("error")
      ? "This sign-in link is invalid or has expired. Please request a new link."
      : undefined;
    if (linkError) window.history.replaceState({}, "", "/");
    try {
      const { data } = getBrowserClient().auth.onAuthStateChange(
        (event, session) => {
          if (active)
            setState((previous) => ({
              ready: true,
              session,
              error: linkError,
              recovery:
                !!session &&
                (event === "PASSWORD_RECOVERY" ||
                  previous.recovery ||
                  new URLSearchParams(window.location.search).get("mode") ===
                    "recovery"),
            }));
        },
      );
      return () => {
        active = false;
        data.subscription.unsubscribe();
      };
    } catch {
      queueMicrotask(() => {
        if (active)
          setState({
            ready: true,
            session: null,
            recovery: false,
            error:
              "Sign-in is temporarily unavailable. Please try again later.",
          });
      });
      return () => {
        active = false;
      };
    }
  }, []);
  if (!state.ready)
    return (
      <main className="loading-page">
        <Brand />
        <p role="status">Opening your space…</p>
      </main>
    );
  if (!state.session || state.recovery)
    return (
      <AuthScreen
        key={state.recovery ? "recovery" : "auth"}
        recovery={state.recovery}
        initialError={state.error}
        onRecovered={() => setState((s) => ({ ...s, recovery: false }))}
      />
    );
  return (
    <CollectionScreen key={state.session.user.id} user={state.session.user} />
  );
}
