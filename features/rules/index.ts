// Public API of domain B, rules (owner: person B). Other domains import only from here.
// Until tasks [B1]–[B3] land this re-exports the mock; B replaces it with the real implementation.
export * from "./mock";
