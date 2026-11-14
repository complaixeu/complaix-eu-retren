import Link from "next/link";
import type { ComponentProps } from "react";
import styles from "./button.module.css";

export type ButtonVariant = "primary" | "secondary" | "quiet";

interface Look {
  variant?: ButtonVariant;
  /** Full width on every screen size (by default buttons are full width only on phones). */
  block?: boolean;
}

const classes = ({ variant = "primary", block }: Look, extra?: string) =>
  [styles.button, styles[variant], block && styles.block, extra].filter(Boolean).join(" ");

/** A real `<button>`. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({
  variant,
  block,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & Look) {
  return <button type={type} className={classes({ variant, block }, className)} {...props} />;
}

/** A link that looks like a button, for moving between pages. */
export function ButtonLink({
  variant,
  block,
  className,
  ...props
}: ComponentProps<typeof Link> & Look) {
  return <Link className={classes({ variant, block }, className)} {...props} />;
}
