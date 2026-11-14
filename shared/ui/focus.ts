/** Anything with `querySelector`, e.g. a `<form>` element. */
export interface QueryRoot {
  querySelector(selector: string): { focus(): void } | null;
}

/**
 * After a failed submit, moves focus to the first control marked `aria-invalid`, so keyboard and
 * screen-reader users land on what to fix. Returns whether there was one.
 */
export function focusFirstInvalid(root: QueryRoot): boolean {
  const first = root.querySelector('[aria-invalid="true"]');
  first?.focus();
  return first != null;
}
