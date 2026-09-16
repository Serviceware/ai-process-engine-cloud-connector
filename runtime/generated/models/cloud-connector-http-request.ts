import type { CloudConnectorHttpMethod } from "./cloud-connector-http-method.ts";

export type CloudConnectorHttpRequest = {
  method: CloudConnectorHttpMethod;
  url: string;
  headers?: {
    [key: string]: (string)[];
  };
  body?: (string) | (null);
  timeoutSeconds?: number;
};
