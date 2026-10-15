"use client";
import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getBrowserClient } from "@/lib/supabase-browser";
import { AuthDialog, type AuthMode } from "./auth-dialog";
import { CollectionScreen } from "@/features/collection/collection-screen";
export function AppEntry({ appUrl }: { appUrl: string }) {
  const [state, setState] = useState<{
    session: Session | null;
    recovery: boolean;
    error?: string;
  }>({ session: null, recovery: false });
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const linkErrorRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    // Preserve the message when development Strict Mode reruns this effect
    // after the sensitive URL fragment has already been cleared.
    if (hash.has("error")) {
      linkErrorRef.current =
        "This sign-in link is invalid or has expired. Please request a new link.";
      window.history.replaceState({}, "", "/");
    }
    try {
      const { data } = getBrowserClient().auth.onAuthStateChange(
        (event, session) => {
          if (active) {
            const linkError = linkErrorRef.current;
            linkErrorRef.current = undefined;
            if (session) setAuthMode(null);
            else if (linkError) setAuthMode("signin");
            setState((previous) => ({
              session,
              error: linkError,
              recovery:
                !!session &&
                (event === "PASSWORD_RECOVERY" ||
                  previous.recovery ||
                  new URLSearchParams(window.location.search).get("mode") ===
                    "recovery"),
            }));
          }
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
  const user = state.recovery ? null : (state.session?.user ?? null);
  return (
    <CollectionScreen
      key={user?.id ?? "guest"}
      user={user}
      onAuthenticate={setAuthMode}
    >
      {(state.recovery || (!state.session && authMode)) && (
        <AuthDialog
          appUrl={appUrl}
          key={state.recovery ? "recovery" : authMode}
          initialMode={state.recovery ? "recovery" : (authMode ?? "signin")}
          initialError={state.error}
          close={() => {
            setAuthMode(null);
            if (state.recovery) window.history.replaceState({}, "", "/");
            setState((s) => ({ ...s, recovery: false, error: undefined }));
          }}
          onRecovered={() => setState((s) => ({ ...s, recovery: false }))}
        />
      )}
    </CollectionScreen>
  );
}
