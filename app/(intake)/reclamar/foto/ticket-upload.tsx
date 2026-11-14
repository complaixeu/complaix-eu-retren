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
  type ReadTicket,
  type TicketChoiceError,
  type TicketTransferProgress,
  type TicketPreviewData,
  type TicketReadingData,
  type TicketUploadStage,
  type TicketUploadRules,
  type TicketUploadState,
} from "./ticket-choice";

export interface TicketUploadProps {
  /** Server action: a signed upload URL for the chosen file. */
  begin: BeginUpload;
  /** Server action: checks the uploaded file, makes it the current draft and reads it. */
  finish: FinishUpload;
  /** Server action: reads the stored ticket again after a failure on our side. */
  read: ReadTicket;
  rules: TicketUploadRules;
  /** The current draft's ticket, or null before the first upload. */
  ticket: TicketPreviewData | null;
  /** What reading the stored ticket gave, or null before the first upload. */
  reading: TicketReadingData | null;
  continueHref: string;
}

const IDLE: TicketUploadState = { status: "idle" };

/** "Otra foto": what happened and what to do next. Stays in view while the next file is chosen. */
function RetryAlert({ heic }: { heic: boolean }) {
  return heic ? (
    <Alert tone="warning" title="No podemos leer fotos HEIC">
      Tu móvil ha guardado la foto en formato HEIC, que todavía no sabemos leer. Haz una captura de
      pantalla del billete, o súbelo como JPG, PNG o PDF. Si tampoco se lee, escribirás los datos a
      mano.
    </Alert>
  ) : (
    <Alert tone="warning" title="No hemos podido leer el billete">
      Puede que la foto esté borrosa, oscura o cortada. Haz otra con el billete entero, plano y con
      buena luz, o sube el PDF que te envió la compañía. Si tampoco se lee, escribirás los datos a
      mano.
    </Alert>
  );
}

/**
 * The upload step: the file field and its "Subir billete" button, and once a ticket is stored,
 * its preview with what reading it gave: "Continuar" if it was read, "Subir otra foto" if not.
 * It gets everything from the server page as props and imports no domain code (see
 * tests/unit/intake/client-boundary.test.ts).
 */
export function TicketUpload({
  begin,
  finish,
  read,
  rules,
  ticket,
  reading,
  continueHref,
}: TicketUploadProps) {
  const [state, setState] = useState<TicketUploadState>(IDLE);
  const [pending, startTransition] = useTransition();
  const [uploadStage, setUploadStage] = useState<TicketUploadStage | null>(null);
  const [transferProgress, setTransferProgress] = useState<TicketTransferProgress | null>(null);
  const [reReading, startReRead] = useTransition();
  const [readFailed, setReadFailed] = useState(false);
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
      const next = await sendTicket(
        file,
        { begin, finish },
        {
          onStage: (stage) => {
            setUploadStage(stage);
            if (stage === "uploading") setTransferProgress({ percent: 0, secondsRemaining: null });
          },
          onProgress: setTransferProgress,
        },
      );
      startTransition(() => {
        setState(next);
        setUploadStage(null);
        setTransferProgress(null);
      });
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

  function readAgain() {
    startReRead(async () => {
      const result = await read();
      startReRead(() => setReadFailed(result.status === "error"));
    });
  }

  const readingState = reading?.state ?? "read";

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
          {readingState === "read" && (
            <p className={styles.note}>
              Ya hemos leído el billete. En el siguiente paso revisas los datos antes de seguir.
            </p>
          )}
          {readingState === "manual" && (
            <p className={styles.note}>
              No hemos podido leer el billete, así que en el siguiente paso escribes los datos a
              mano.
            </p>
          )}
          {readingState === "retry" && <RetryAlert heic={reading?.heic ?? false} />}
          {readingState === "pending" && (
            <Alert tone="error" title="Todavía no hemos leído el billete">
              {readFailed
                ? "Sigue fallando por nuestra parte. Vuelve a intentarlo dentro de unos minutos."
                : "El billete se ha subido, pero ha fallado algo por nuestra parte al leerlo. Vuelve a intentarlo: no hace falta subirlo otra vez."}
            </Alert>
          )}
          {readingState !== "retry" && (
            <div>
              <Button variant="quiet" onClick={startReplacing} className={styles.replace}>
                Cambiar archivo
              </Button>
            </div>
          )}
        </section>
        <div className={intake.actions}>
          {readingState === "retry" ? (
            <Button onClick={startReplacing}>Subir otra foto</Button>
          ) : readingState === "pending" ? (
            <Button onClick={readAgain} pending={reReading}>
              Leer el billete
            </Button>
          ) : (
            <ButtonLink href={continueHref}>Continuar</ButtonLink>
          )}
        </div>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className={styles.form}>
      {reading?.state === "retry" && <RetryAlert heic={reading.heic} />}
      {serverError === "failed" && (
        <Alert tone="error" title="No se ha subido el billete">
          {rules.messages.failed}
        </Alert>
      )}
      <Field
        label="Foto o PDF del billete"
        help="JPG, PNG o PDF, hasta 10 MB. Que se vea el billete entero y sin reflejos."
        error={fieldError ? rules.messages[fieldError] : undefined}
      >
        {(control) => (
          <FileInput
            {...control}
            ref={inputRef}
            name="ticket"
            accept={rules.accept}
            disabled={pending}
            aria-required="true"
            onChange={onChange}
          />
        )}
      </Field>
      {pending && uploadStage === "uploading" && (
        <div className={styles.uploadFeedback}>
          <div className={styles.progressLabel}>
            <span>Subida del billete</span>
            <strong>{transferProgress?.percent ?? 0} %</strong>
          </div>
          <progress
            className={styles.progressBar}
            value={transferProgress?.percent ?? 0}
            max={100}
            aria-label="Subida del billete"
          />
          <p className={styles.progressNote}>
            {remainingMessage(transferProgress?.secondsRemaining ?? null)}
          </p>
        </div>
      )}
      {pending && uploadStage !== "uploading" && (
        <p role="status" aria-live="polite" className={styles.progress}>
          {uploadStage === "checking"
            ? "Archivo subido. Comprobando y leyendo el billete…"
            : "Preparando la subida…"}
        </p>
      )}
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

function remainingMessage(seconds: number | null): string {
  if (seconds === 0) return "Archivo enviado. Terminando la subida…";
  if (seconds === null) return "Calculando el tiempo restante…";
  return `Quedan unos ${seconds} s.`;
}
