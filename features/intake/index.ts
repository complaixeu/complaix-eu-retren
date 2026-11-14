// Domain A, intake (owner: person A). Its output reaches other domains only through
// `createCase` (domain C), so it exports nothing to them; keep it that way (A → C → B).
// Server-side only, for A1/A3 server code (never import from a client component):
export { createOcr } from "./ocr";
