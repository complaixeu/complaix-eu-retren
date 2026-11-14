import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { teamAccessMode } from "../../../../features/claims/team-access";
import { Alert, Button, Field, Input } from "@/shared/ui";
import { login } from "../actions";
import styles from "../team.module.css";

export const metadata: Metadata = { title: "Team sign-in" };

export default function TeamLoginPage({ searchParams }: PageProps<"/equipo/entrar">) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <LoginForm searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginForm({ searchParams }: Pick<PageProps<"/equipo/entrar">, "searchParams">) {
  // Env and session are read per request, never frozen into the build.
  await connection();
  const mode = teamAccessMode();
  if (mode === "disabled") notFound();
  if (mode === "open") redirect("/equipo");
  const { error } = await searchParams;

  return (
    <section className={`${styles.card} ${styles.narrow}`}>
      <h1 className={styles.title}>Team sign-in</h1>
      {error && (
        // Same message for a wrong password and for an address that is not on the list.
        <Alert tone="error">
          Email or password is incorrect, or this account does not have team access.
        </Alert>
      )}
      <form action={login} className={styles.list}>
        <Field label="Email">
          {(control) => (
            <Input {...control} name="email" type="email" autoComplete="username" required />
          )}
        </Field>
        <Field label="Password">
          {(control) => (
            <Input
              {...control}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          )}
        </Field>
        <Button type="submit">Sign in</Button>
      </form>
    </section>
  );
}
