import Image from "next/image";

/** The project-provided train mark, paired with the wordmark in the public site shell. */
export function RetrenLogo() {
  return (
    <Image src="/gemini-svg.svg" alt="" aria-hidden="true" width={32} height={32} unoptimized />
  );
}
