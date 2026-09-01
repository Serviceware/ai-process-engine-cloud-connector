import type { CloudConnectorHeartbeatFrame } from "./cloud-connector-heartbeat-frame.ts";
import type { CloudConnectorRequestFrame } from "./cloud-connector-request-frame.ts";
import type { CloudConnectorResponseFrame } from "./cloud-connector-response-frame.ts";

type CloudConnectorMessageFrameDiscriminator =
  | ("request")
  | ("response")
  | ("heartbeat");

export type _CloudConnectorMessageFrameBase =
  | (CloudConnectorRequestFrame)
  | (CloudConnectorResponseFrame)
  | (CloudConnectorHeartbeatFrame);

export type CloudConnectorMessageFrame<
  TType extends CloudConnectorMessageFrameDiscriminator =
    CloudConnectorMessageFrameDiscriminator,
> =
  & (_CloudConnectorMessageFrameBase)
  & (({
    request:
      & ({
        type: "request";
      })
      & (CloudConnectorRequestFrame);
    response:
      & ({
        type: "response";
      })
      & (CloudConnectorResponseFrame);
    heartbeat:
      & ({
        type: "heartbeat";
      })
      & (CloudConnectorHeartbeatFrame);
  })[TType]);
