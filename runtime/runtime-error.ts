import type { CloudConnectorError } from "./generated/models.ts";

export class RuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "RuntimeError";
  }
}

const maxCauseDepth = 5;

/**
 * Node's fetch reports "fetch failed" and keeps the reason in `cause`. Error
 * codes such as `ECONNREFUSED` name it without revealing internal addresses.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const codes = [...new Set(errorCodes(error, maxCauseDepth))];
  return codes.length === 0 ? message : `${message} (${codes.join(", ")})`;
}

function errorCodes(error: unknown, depth: number): string[] {
  if (depth === 0 || !(error instanceof Error)) return [];
  const code = (error as { code?: unknown }).code;
  const nested =
    error instanceof AggregateError
      ? error.errors.flatMap((inner) => errorCodes(inner, depth - 1))
      : [];
  return [
    ...(typeof code === "string" ? [code] : []),
    ...nested,
    ...errorCodes(error.cause, depth - 1),
  ];
}

export function toCloudConnectorError(error: unknown): CloudConnectorError {
  if (error instanceof RuntimeError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "UNEXPECTED_ERROR",
      message: error.message,
    };
  }

  return {
    code: "UNEXPECTED_ERROR",
    message: String(error),
  };
}
