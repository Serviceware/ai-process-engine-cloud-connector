import type { CloudConnectorHeartbeatFrame } from "./cloud-connector-heartbeat-frame.ts";
import type { CloudConnectorRequestFrame } from "./cloud-connector-request-frame.ts";
import type { CloudConnectorResponseFrame } from "./cloud-connector-response-frame.ts";

type CloudConnectorFrameDiscriminator =
  | ("request")
  | ("response")
  | ("heartbeat");

export type _CloudConnectorFrameBase = {
  type: string;
};

export type CloudConnectorFrame<
  TType extends CloudConnectorFrameDiscriminator =
    CloudConnectorFrameDiscriminator,
> =
  & (_CloudConnectorFrameBase)
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
