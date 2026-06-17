import type { _CloudConnectorFrameBase } from "./cloud-connector-frame.ts";
import type { CloudConnectorHeartbeatFrameType } from "./cloud-connector-heartbeat-frame-type.ts";

export type CloudConnectorHeartbeatFrame =
  & (Omit<
    & (_CloudConnectorFrameBase)
    & ({
      type: CloudConnectorHeartbeatFrameType;
      sentAt?: string;
    }),
    "type"
  >)
  & ({
    type: ("heartbeat") | ("heartbeat");
  });
