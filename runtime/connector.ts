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
  maximumConcurrentRequests?: number;
};

export type WebSocketAttachment = {
  /** Stops accepting requests and waits up to the supplied timeout. */
  drain: (timeoutMs: number) => Promise<boolean>;
};

export class ConnectorRuntime {
  private readonly logger: RuntimeLogger;
  private readonly maximumConcurrentRequests: number;

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.logger = options.logger ?? createLogger();
    this.maximumConcurrentRequests = options.maximumConcurrentRequests ?? 100;
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

  attachWebSocket(socket: WebSocket): WebSocketAttachment {
    const inFlight = new Set<Promise<void>>();
    let acceptingRequests = true;
    const send = (frame: WritableFrame) => socket.send(serializeFrame(frame));

    socket.addEventListener("message", (event) => {
      let frame: CloudConnectorMessageFrame;
      try {
        frame = parseMessageFrame(event.data);
      } catch (error) {
        this.logger.warn(toCloudConnectorError(error).message);
        return;
      }

      if (isRequestFrame(frame) && !acceptingRequests) {
        void Promise.resolve(send(createErrorFrame(frame.requestId, {
          code: "CONNECTOR_DRAINING",
          message: "Cloud Connector is draining before reconnect or shutdown",
        }))).catch((error) => {
          this.logger.error(
            `Failed to reject draining request ${frame.requestId}`,
            error,
          );
        });
        return;
      }
      if (
        isRequestFrame(frame) &&
        inFlight.size >= this.maximumConcurrentRequests
      ) {
        void Promise.resolve(send(createErrorFrame(frame.requestId, {
          code: "TOO_MANY_REQUESTS",
          message: "Cloud Connector request concurrency limit reached",
        }))).catch((error) => {
          this.logger.error(
            `Failed to reject excess request ${frame.requestId}`,
            error,
          );
        });
        return;
      }

      const task = this.handleFrame(frame, send).catch((error) => {
        const requestId = isRequestFrame(frame)
          ? ` for request ${frame.requestId}`
          : "";
        this.logger.error(
          `Failed to process WebSocket message${requestId}`,
          error,
        );
      });
      if (isRequestFrame(frame)) {
        inFlight.add(task);
        void task.finally(() => inFlight.delete(task));
      }
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

    return {
      drain: async (timeoutMs) => {
        acceptingRequests = false;
        if (inFlight.size === 0) return true;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<false>((resolve) => {
          timeoutId = setTimeout(() => resolve(false), timeoutMs);
        });
        const drained = Promise.allSettled([...inFlight]).then(() => true);
        const result = await Promise.race([drained, timedOut]);
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        return result;
      },
    };
  }

  private async handleRequestFrame(
    frame: CloudConnectorRequestFrame,
    send: FrameSender,
  ): Promise<void> {
    try {
      const response = await this.options.protocolExecutor.execute(frame);
      await send(createResponseFrame(frame.requestId, response));
    } catch (error) {
      const connectorError = toCloudConnectorError(error);
      this.logger.warn(
        `Forwarding request ${frame.requestId} failed: ${connectorError.code}`,
      );
      await send(
        createErrorFrame(frame.requestId, connectorError),
      );
    }
  }
}
