export function formatToolError(command: string, error: unknown): string {
  const original = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "ENOENT" || code === "EACCES") {
    return `${command} could not be started: ${original}. Install ${command} and ensure it is available on PATH; see README prerequisites.`;
  }
  return original;
}
