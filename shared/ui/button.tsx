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

export type ButtonProps = ComponentProps<"button"> &
  Look & {
    /**
     * While a submit is in flight: disabled and `aria-busy`, with the same label, so a double tap
     * can't send twice and nothing jumps.
     */
    pending?: boolean;
  };

/** A real `<button>`. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({
  variant,
  block,
  pending,
  disabled,
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes({ variant, block }, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    />
  );
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
