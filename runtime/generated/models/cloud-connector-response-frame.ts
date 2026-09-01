import type { CloudConnectorError } from "./cloud-connector-error.ts";
import type { _CloudConnectorFrameBase } from "./cloud-connector-frame.ts";
import type { CloudConnectorHttpResponse } from "./cloud-connector-http-response.ts";
import type { CloudConnectorResponseFrameType } from "./cloud-connector-response-frame-type.ts";

export type CloudConnectorResponseFrame =
  & (Omit<
    & (_CloudConnectorFrameBase)
    & ({
      type: CloudConnectorResponseFrameType;
      requestId: string;
      response?: CloudConnectorHttpResponse;
      error?: CloudConnectorError;
    }),
    "type"
  >)
  & ({
    type: ("response") | ("response");
  });
