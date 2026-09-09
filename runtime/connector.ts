import type {
  CloudConnectorHttpResponse,
  CloudConnectorMessageFrame,
  CloudConnectorRequestFrame,
} from "./generated/models.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import type { WritableFrame } from "./protocol.ts";
import {
  createErrorFrame,
  createHeartbeatFrame,
  createResponseFrame,
  isHeartbeatFrame,
  isRequestFrame,
  parseMessageFrame,
  serializeFrame,
} from "./protocol.ts";
import { toCloudConnectorError } from "./runtime-error.ts";

export type FrameSender = (frame: WritableFrame) => void | Promise<void>;

/**
 * Forwards the HTTP request carried by one inbound cloud frame.
 */
export interface ProtocolExecutor {
  execute(
    frame: CloudConnectorRequestFrame,
  ): Promise<CloudConnectorHttpResponse>;
}

/**
 * Keeps in-flight requests on the snapshot they started with while switching
 * all subsequent requests to a newly validated YAML configuration.
 */
export class ReloadableProtocolExecutor implements ProtocolExecutor {
  constructor(private current: ProtocolExecutor) {}

  replace(next: ProtocolExecutor): void {
    this.current = next;
  }

  execute(
    frame: CloudConnectorRequestFrame,
  ): Promise<CloudConnectorHttpResponse> {
    const snapshot = this.current;
    return snapshot.execute(frame);
  }
}

export type ConnectorRuntimeOptions = {
  /** Protocol executor that handles inbound request frames. */
  protocolExecutor: ProtocolExecutor;
  logger?: RuntimeLogger;
};

export class ConnectorRuntime {
  private readonly logger: RuntimeLogger;

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.logger = options.logger ?? createLogger();
  }

  async handleFrame(
    frame: CloudConnectorMessageFrame,
    send: FrameSender,
  ): Promise<void> {
    if (isHeartbeatFrame(frame)) {
      this.logger.info("Received heartbeat frame; sending heartbeat response");
      await send(createHeartbeatFrame());
      return;
    }

    if (!isRequestFrame(frame)) {
      this.logger.warn(
        `Ignoring unsupported inbound frame type: ${frame.type}`,
      );
      return;
    }

    await this.handleRequestFrame(frame, send);
  }

  attachWebSocket(socket: WebSocket): void {
    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(
        event.data,
        (frame) => socket.send(serializeFrame(frame)),
      ).catch((error) => {
        this.logger.error("Failed to process WebSocket message", error);
      });
    });

    socket.addEventListener("open", () => {
      this.logger.info("Cloud Connector WebSocket opened");
    });

    socket.addEventListener("close", (e) => {
      this.logger.warn("Cloud Connector WebSocket closed", {
        code: e.code,
        reason: e.reason,
      });
    });
  }

  private async handleSocketMessage(
    data: unknown,
    send: FrameSender,
  ): Promise<void> {
    let frame: CloudConnectorMessageFrame;
    try {
      frame = parseMessageFrame(data);
    } catch (error) {
      this.logger.warn(toCloudConnectorError(error).message);
      return;
    }

    await this.handleFrame(frame, send);
  }

  private async handleRequestFrame(
    frame: CloudConnectorRequestFrame,
    send: FrameSender,
  ): Promise<void> {
    try {
      const response = await this.options.protocolExecutor.execute(frame);
      await send(createResponseFrame(frame.requestId, response));
    } catch (error) {
      await send(
        createErrorFrame(frame.requestId, toCloudConnectorError(error)),
      );
    }
  }
}
