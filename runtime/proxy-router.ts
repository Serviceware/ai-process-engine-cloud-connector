/**
 * HTTP Proxy Executor
 *
 * Transparent pass-through used when no functions are present. Each inbound
 * request frame already carries the absolute target URL it should reach inside
 * the customer network, so the Cloud Connector simply forwards the request 1:1 and
 * returns whatever the upstream responds. Target URLs are still subject to the
 * configured outbound URL allowlist.
 *
 * @module
 */

import type { ProtocolExecutor } from "./connector.ts";
import type {
    CloudConnectorHttpResponse,
    CloudConnectorRequestFrame,
} from "./generated/models.ts";
import type { RuntimeLogger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import type { Fetcher } from "./outbound-url-policy.ts";
import { RuntimeError } from "./runtime-error.ts";

export type HttpProxyExecutorOptions = {
    logger?: RuntimeLogger;
    fetcher?: Fetcher;
};

export class HttpProxyExecutor implements ProtocolExecutor {
    private readonly logger: RuntimeLogger;
    private readonly fetcher: Fetcher;

    constructor(options: HttpProxyExecutorOptions = {}) {
        this.logger = options.logger ?? createLogger();
        this.fetcher = options.fetcher ?? globalThis.fetch;
    }

    async execute(
        frame: CloudConnectorRequestFrame,
    ): Promise<CloudConnectorHttpResponse> {
        const { request } = frame;

        let targetUrl: URL;
        try {
            targetUrl = new URL(request.url);
        } catch {
            throw new RuntimeError(
                "INVALID_TARGET",
                `Proxy mode requires an absolute request URL, received "${request.url}"`,
            );
        }

        const headers = new Headers();
        if (request.headers) {
            for (const [name, values] of Object.entries(request.headers)) {
                for (const value of values) {
                    headers.append(name, value);
                }
            }
        }
        // Host is derived from the target URL by fetch.
        headers.delete("host");

        this.logger.info(`Proxying ${request.method} ${targetUrl.href}`);

        const response = await this.fetcher(targetUrl, {
            method: request.method,
            headers,
            body: request.method === "GET" || request.method === "HEAD"
                ? undefined
                : request.body ?? undefined,
        });

        const responseHeaders: Record<string, string[]> = {};
        response.headers.forEach((value, name) => {
            (responseHeaders[name] ??= []).push(value);
        });
        const body = await response.text();
        this.logger.debug(
            `Proxy response ${response.status} from ${targetUrl.href}`,
        );

        return {
            statusCode: response.status,
            headers: responseHeaders,
            body: body || null,
        };
    }
}
