import type { CloudConnectorError } from "./generated/models.ts";

export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeError";
  }
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
