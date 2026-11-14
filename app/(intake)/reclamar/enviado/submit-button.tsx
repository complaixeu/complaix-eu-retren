"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/shared/ui";

/** The submit button of the retry form: disabled while the request is in flight. */
export function SubmitButton({ children }: { children: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" pending={pending}>
      {children}
    </Button>
  );
}
