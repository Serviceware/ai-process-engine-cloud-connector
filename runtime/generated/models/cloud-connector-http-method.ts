export type CloudConnectorHttpMethod =
  | ("GET")
  | ("POST")
  | ("PUT")
  | ("PATCH")
  | ("DELETE")
  | ("HEAD")
  | ("OPTIONS");

/**
 * All possible values of the enum `CloudConnectorHttpMethod`.
 */
export const CLOUD_CONNECTOR_HTTP_METHOD_VALUES = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
