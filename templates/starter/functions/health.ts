/**
 * Health Endpoint
 *
 * GET /health - Returns Cloud Connector status.
 */

import { http } from "@serviceware/cloud-connector-sdk";

export default http()
    .get((ctx) => {
        return ctx.res.ok().json({
            status: "ok",
            timestamp: ctx.startedAt,
        });
    });
