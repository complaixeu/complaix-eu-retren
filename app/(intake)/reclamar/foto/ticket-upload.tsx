"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { Alert, Button, ButtonLink, Field, FileInput } from "@/shared/ui";
import intake from "../_components/intake.module.css";
import styles from "./foto.module.css";
import {
  formatFileSize,
  sendTicket,
  ticketChoiceError,
  type BeginUpload,
  type FinishUpload,
  type TicketChoiceError,
  type TicketPreviewData,
  type TicketUploadRules,
  type TicketUploadState,
} from "./ticket-choice";

export interface TicketUploadProps {
  /** Server action: a signed upload URL for the chosen file. */
  begin: BeginUpload;
  /** Server action: checks the uploaded file and makes it the current draft. */
  finish: FinishUpload;
  rules: TicketUploadRules;
  /** The current draft's ticket, or null before the first upload. */
  ticket: TicketPreviewData | null;
  continueHref: string;
}

const IDLE: TicketUploadState = { status: "idle" };

/**
 * The upload step: the file field and its "Subir billete" button, and once a ticket is stored,
 * its preview with "Continuar". It gets everything from the server page as props and imports no
 * domain code (see tests/unit/intake/client-boundary.test.ts).
 */
export function TicketUpload({ begin, finish, rules, ticket, continueHref }: TicketUploadProps) {
  const [state, setState] = useState<TicketUploadState>(IDLE);
  const [pending, startTransition] = useTransition();
  const [choiceError, setChoiceError] = useState<TicketChoiceError | null>(null);
  // A server error stays until the user picks another file.
  const [dismissed, setDismissed] = useState<TicketUploadState | null>(null);
  // Set to the shown ticket's key while the user is choosing a replacement for it.
  const [replacing, setReplacing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  const serverError = state.status === "error" && state !== dismissed ? state.error : null;
  const fieldError = choiceError ?? (serverError !== "failed" ? serverError : null);
  const showForm = !ticket || replacing === ticket.key;

  // After the server answers: on success the preview has the new ticket, so move to it; on a
  // rejected file, back to the field, which now carries the error.
  useEffect(() => {
    if (state.status === "ok" && ticket?.key === state.key) headingRef.current?.focus();
    if (state.status === "error" && state.error !== "failed") inputRef.current?.focus();
  }, [state, ticket?.key]);

  // On a slow phone the user may pick the file before the page is interactive: check it then.
  useEffect(() => {
    const file = inputRef.current?.files?.[0];
    if (file) setChoiceError(ticketChoiceError(file, rules));
  }, [rules]);

  function onChange() {
    const file = inputRef.current?.files?.[0];
    setDismissed(state);
    setChoiceError(file ? ticketChoiceError(file, rules) : null);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    const error = ticketChoiceError(file, rules);
    if (error || !file) {
      flushSync(() => {
        setDismissed(state);
        setChoiceError(error ?? "missing");
      });
      inputRef.current?.focus();
      return;
    }
    // The file goes straight to Storage; our server only gets two small requests around it.
    startTransition(async () => {
      const next = await sendTicket(file, { begin, finish });
      startTransition(() => setState(next));
    });
  }

  function startReplacing() {
    if (!ticket) return;
    flushSync(() => {
      setReplacing(ticket.key);
      setChoiceError(null);
      setDismissed(state);
    });
    inputRef.current?.focus();
  }

  function stopReplacing() {
    flushSync(() => setReplacing(null));
    headingRef.current?.focus();
  }

  if (!showForm) {
    return (
      <>
        <section aria-labelledby={headingId} className={styles.ticket}>
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
            Tu billete
          </h2>
          {/* One object: the ticket itself (or its type stamp), then its name and size. */}
          <div className={styles.file}>
            {ticket.imageUrl && (
              <div className={styles.frame}>
                {/* A short-lived signed link to a private file: not for the optimizer's cache. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={ticket.imageUrl}
                  alt="Vista previa de tu billete"
                  className={styles.image}
                />
              </div>
            )}
            <div className={styles.row}>
              {!ticket.imageUrl && (
                <span className={styles.badge} aria-hidden="true">
                  {ticket.typeLabel}
                </span>
              )}
              <div className={styles.meta}>
                <p className={styles.name}>{ticket.filename}</p>
                <p className={styles.details}>
                  {ticket.typeLabel} · {formatFileSize(ticket.sizeBytes)}
                </p>
              </div>
            </div>
          </div>
          <p className={styles.note}>
            En el siguiente paso leemos los datos del billete y los revisas antes de seguir.
          </p>
          <div>
            <Button variant="quiet" onClick={startReplacing} className={styles.replace}>
              Cambiar archivo
            </Button>
          </div>
        </section>
        <div className={intake.actions}>
          <ButtonLink href={continueHref}>Continuar</ButtonLink>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className={styles.form}>
      {serverError === "failed" && (
        <Alert tone="error" title="No se ha subido el billete">
          {rules.messages.failed}
        </Alert>
      )}
      <Field
        label="Foto o PDF del billete"
        help="JPG, PNG, HEIC o PDF, hasta 10 MB. Que se vea el billete entero y sin reflejos."
        error={fieldError ? rules.messages[fieldError] : undefined}
      >
        {(control) => (
          <FileInput
            {...control}
            ref={inputRef}
            name="ticket"
            accept={rules.accept}
            aria-required="true"
            onChange={onChange}
          />
        )}
      </Field>
      <p role="status" className={styles.progress}>
        {pending ? "Subiendo el billete. Con una conexión lenta puede tardar un poco." : ""}
      </p>
      <div className={intake.actions}>
        <Button type="submit" pending={pending}>
          Subir billete
        </Button>
        {ticket && (
          <Button variant="quiet" onClick={stopReplacing} disabled={pending}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
