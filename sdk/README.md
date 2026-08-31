# @serviceware/cloud-connector-sdk

SDK for developing Cloud Connector functions.

## Installation

```json
// deno.json
{
  "imports": {
    "@serviceware/cloud-connector-sdk": "jsr:@serviceware/cloud-connector-sdk@3"
  }
}
```

---

## HTTP Function Mode (recommended)

HTTP Function Mode is the recommended way to develop Cloud Connector endpoints.
You define your API endpoints as TypeScript files in a `functions/` directory.

### Quick Start

```typescript
// functions/users/index.ts
import { defineHttp, http } from "@serviceware/cloud-connector-sdk";

export default defineHttp({
  get: (ctx) => ctx.res.ok().json({ users: [] }),

  post: async (ctx) => {
    const body = await ctx.req.body.json<{ name: string }>();
    return ctx.res.created().json({ created: body.name });
  },
});

// Fluent style is equally supported:
export const route = http()
  .get((ctx) => ctx.res.ok().json({ users: [] }))
  .post(async (ctx) => {
    const body = await ctx.req.body.json<{ name: string }>();
    return ctx.res.created().json({ created: body.name });
  });
```

### HttpContext

The `ctx` parameter contains all information about the request:

```typescript
ctx.requestId; // Request UUID
ctx.startedAt; // ISO 8601 timestamp
ctx.req.method; // HTTP method (GET, POST, etc.)
ctx.req.url; // URL object with pathname, search, etc.
ctx.req.params.get("id"); // URL parameters
ctx.req.query.get("department"); // Query parameter
ctx.req.headers; // Request headers
ctx.env; // Environment variables
ctx.req.raw; // Original Request object
ctx.res; // Response factory
ctx.proxy; // HTTP proxy builder
ctx.upstream("https://internal.example"); // Upstream request builder
```

### Reading Body

```typescript
// As typed JSON
const data = await ctx.req.body.json<MyType>();

// As text
const text = await ctx.req.body.text();

// As FormData
const form = await ctx.req.body.formData();

// As ArrayBuffer
const buffer = await ctx.req.body.arrayBuffer();
```

### Responses

```typescript
// JSON response (200 OK)
return ctx.res.ok().json({ data: "value" });

// JSON with status code
return ctx.res.created().json({ created: true });

// Text response
return ctx.res.ok().text("Hello World");

// 204 No Content
return ctx.res.noContent();

// Error response
return ctx.res.badRequest("Invalid request");
return ctx.res.notFound("Not found");
return ctx.res.internalServerError("Internal error");

// Custom Response
return new Response(body, { status: 200, headers: { ... } });
```

### URL Parameters

```typescript
// functions/users/[id].ts → /users/:id
export default defineHttp({
  get: (ctx) => {
    const id = ctx.req.params.require("id"); // e.g., "123"
    return ctx.res.ok().json({ userId: id });
  },
});
```

### Catch-All Parameters

```typescript
// functions/files/[...path].ts → /files/*
export default defineHttp({
  get: (ctx) => {
    const path = ctx.req.params.require("path"); // e.g., "a/b/c.txt"
    return ctx.res.ok().json({ filePath: path });
  },
});
```

### Calling External Systems

```typescript
// functions/ad/users.ts
import { defineHttp } from "@serviceware/cloud-connector-sdk";

export default defineHttp({
  get: async (ctx) => {
    const bridgeUrl = ctx.env.AD_BRIDGE_URL;
    const token = ctx.env.AD_BRIDGE_TOKEN;

    const response = await fetch(`${bridgeUrl}/api/v1/users`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "X-Request-Id": ctx.requestId,
      },
    });

    if (!response.ok) {
      return ctx.res.error(response.status, "Bridge error");
    }

    const data = await response.json();
    return ctx.res.ok().json(data);
  },
});
```
