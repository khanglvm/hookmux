// Defensive readers for untrusted host payloads.

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
