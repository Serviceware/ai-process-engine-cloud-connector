import type { _CloudConnectorFrameBase } from "./cloud-connector-frame.ts";
import type { CloudConnectorHttpRequest } from "./cloud-connector-http-request.ts";
import type { CloudConnectorRequestFrameType } from "./cloud-connector-request-frame-type.ts";

export type CloudConnectorRequestFrame =
  & (Omit<
    & (_CloudConnectorFrameBase)
    & ({
      type: CloudConnectorRequestFrameType;
      requestId: string;
      request: CloudConnectorHttpRequest;
    }),
    "type"
  >)
  & ({
    type: ("request") | ("request");
  });
