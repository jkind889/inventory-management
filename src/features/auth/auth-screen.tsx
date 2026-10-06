"use client";
import { useState } from "react";
import { Brand, Icon } from "@/components/icon";
import { getBrowserClient } from "@/lib/supabase-browser";
import { errorMessage } from "@/lib/api";
import { currencies } from "@/shared/contracts";

type Mode = "signin" | "signup" | "forgot" | "recovery";
export function AuthScreen({
  recovery = false,
  initialError,
  onRecovered,
}: {
  recovery?: boolean;
  initialError?: string;
  onRecovered: () => void;
}) {
  const [mode, setMode] = useState<Mode>(recovery ? "recovery" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const [notice, setNotice] = useState("");
  function changeMode(next: Mode) {
    setMode(next);
    setError("");
    setNotice("");
    setPassword("");
    setShow(false);
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const client = getBrowserClient();
      if (mode === "signin") {
        const { error } = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: {
              preferred_currency: currency,
              preferred_timezone:
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setNotice(
            "Check your email to confirm your account, then return here to sign in.",
          );
          setPassword("");
        }
      } else if (mode === "forgot") {
        const { error } = await client.auth.resetPasswordForEmail(
          email.trim(),
          { redirectTo: `${window.location.origin}/?mode=recovery` },
        );
        if (error) throw error;
        setNotice(
          "If an account exists for that email, a password reset link is on its way.",
        );
      } else {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        window.history.replaceState({}, "", "/");
        onRecovered();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const title = {
    signin: "Welcome back.",
    signup: "Make yourself at home.",
    forgot: "Let’s get you back in.",
    recovery: "A fresh start.",
  }[mode];
  const subtitle = {
    signin: "Your collection is right where you left it.",
    signup: "Start a collection that feels like you.",
    forgot: "We’ll send you a link to reset your password.",
    recovery: "Choose a new password for your account.",
  }[mode];
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div className="story-copy">
          <h1>
            Make room
            <br />
            for what
            <br />
            matters.
          </h1>
          <p>
            A home for the things you own, the purchases you plan, and the value
            you find along the way.
          </p>
          <div className="story-objects" aria-hidden="true">
            <div>
              <Icon name="headphones" size={80} />
            </div>
            <div>
              <Icon name="chair" size={80} />
            </div>
            <div>
              <Icon name="camera" size={80} />
            </div>
          </div>
        </div>
      </section>
      <section className="auth-form-side">
        <div className="auth-form-wrap">
          <h2>{title}</h2>
          <p className="auth-subtitle">{subtitle}</p>
          <form onSubmit={submit} className="auth-form">
            {mode !== "recovery" && (
              <label className="field">
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {mode !== "forgot" && (
              <label className="field">
                {mode === "recovery" ? "New password" : "Password"}
                <span className="password-input">
                  <input
                    name="password"
                    type={show ? "text" : "password"}
                    autoComplete={
                      mode === "signin" ? "current-password" : "new-password"
                    }
                    minLength={mode === "signin" ? undefined : 8}
                    maxLength={128}
                    required
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={show ? "Hide password" : "Show password"}
                    onClick={() => setShow((v) => !v)}
                  >
                    <Icon name={show ? "eyeOff" : "eye"} />
                  </button>
                </span>
                {mode !== "signin" && (
                  <span className="field-help">Use at least 8 characters.</span>
                )}
              </label>
            )}
            {mode === "signup" && (
              <label className="field">
                Your currency
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={busy}
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <span className="field-help">
                  Used for your purchases and spending.
                </span>
              </label>
            )}
            {mode === "signin" && (
              <button
                type="button"
                className="text-button forgot"
                onClick={() => changeMode("forgot")}
              >
                Forgot password?
              </button>
            )}
            {error && (
              <div className="form-message error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="form-message success" role="status">
                {notice}
              </div>
            )}
            <button className="button primary auth-submit" disabled={busy}>
              {busy
                ? "Please wait…"
                : {
                    signin: "Sign in",
                    signup: "Create account",
                    forgot: "Send reset link",
                    recovery: "Save new password",
                  }[mode]}
              {!busy && <Icon name="arrow" />}
            </button>
          </form>
          {mode !== "recovery" && (
            <p className="auth-switch">
              {mode === "signin" ? (
                <>
                  New here?{" "}
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => changeMode("signup")}
                  >
                    Create an account
                  </button>
                </>
              ) : (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => changeMode("signin")}
                >
                  Back to sign in
                </button>
              )}
            </p>
          )}
        </div>
        <p className="auth-private">
          <Icon name="lock" size={17} />
          Your collection, just for you.
        </p>
      </section>
    </main>
  );
}
