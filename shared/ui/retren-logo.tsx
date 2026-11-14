/** Compact ReTren mark paired with the wordmark in the public site shell. */
export function RetrenLogo() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        d="M10 7.5h12a2 2 0 0 1 2 2v11.25a2.75 2.75 0 0 1-2.75 2.75h-.5l2 2.5h-2.5l-2-2.5h-4.5l-2 2.5h-2.5l2-2.5h-.5A2.75 2.75 0 0 1 8.5 20.75V9.5a2 2 0 0 1 2-2Z"
        fill="var(--color-on-primary)"
      />
      <path d="M11 10h10v6H11z" fill="currentColor" />
      <path d="M11 18.5h10v2H11z" fill="var(--color-accent)" />
      <circle cx="12.5" cy="21.5" r="1" fill="currentColor" />
      <circle cx="19.5" cy="21.5" r="1" fill="currentColor" />
    </svg>
  );
}
