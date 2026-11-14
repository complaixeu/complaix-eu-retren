"use client";

import { useEffect, useState } from "react";
import styles from "./form-completion.module.css";

interface Completion {
  complete: number;
  total: number;
}

/** Shows live completion of required controls without duplicating server validation rules. */
export function FormCompletion({
  formRef,
  label = "Campos obligatorios",
}: {
  formRef: { current: HTMLFormElement | null };
  label?: string;
}) {
  const [completion, setCompletion] = useState<Completion>({ complete: 0, total: 0 });

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    const update = () => setCompletion(countRequiredFields(form));
    update();
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(form, { childList: true, subtree: true });

    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
      observer.disconnect();
    };
  }, [formRef]);

  const { complete, total } = completion;
  const ratio = total === 0 ? 0 : complete / total;
  const text = `${complete} de ${total} campos completos`;

  return (
    <div className={styles.completion}>
      <div className={styles.labelRow}>
        <span>{label}</span>
        <span>{text}</span>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={complete}
        aria-valuetext={text}
      >
        <span className={styles.fill} style={{ transform: `scaleX(${ratio})` }} />
      </div>
    </div>
  );
}

function countRequiredFields(form: HTMLFormElement): Completion {
  const controls = Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input[required], input[aria-required='true'], select[required], select[aria-required='true'], textarea[required], textarea[aria-required='true']",
    ),
  ).filter((control) => !control.disabled && control.type !== "hidden");
  const radioGroups = new Map<string, HTMLInputElement[]>();
  let complete = 0;
  let total = 0;

  for (const control of controls) {
    if (control instanceof HTMLInputElement && control.type === "radio" && control.name) {
      if (radioGroups.has(control.name)) continue;
      const group = controls.filter(
        (candidate): candidate is HTMLInputElement =>
          candidate instanceof HTMLInputElement &&
          candidate.type === "radio" &&
          candidate.name === control.name,
      );
      radioGroups.set(control.name, group);
      total++;
      if (group.some((radio) => radio.checked)) complete++;
      continue;
    }

    total++;
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
      if (control.checked) complete++;
    } else if (control instanceof HTMLInputElement && control.type === "file") {
      if (control.files?.length) complete++;
    } else if (control.value.trim() && control.checkValidity()) {
      complete++;
    }
  }

  return { complete, total };
}
