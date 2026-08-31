# Cloud Connector – Installation Guide

This guide describes step by step how to install and configure the Edge
Connector in your network.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Network Requirements](#network-requirements)
4. [Installation](#installation)
5. [Configuration](#configuration)
6. [Creating Functions](#creating-functions)
7. [YAML Functions (optional)](#yaml-functions-optional)
8. [Starting and Testing](#starting-and-testing)
9. [Production Operation](#production-operation)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The Cloud Connector is a lightweight proxy service that runs in your network
(typically in the DMZ). It establishes an **outbound** WebSocket connection to
the Serviceware Cloud, enabling secure communication between cloud workflows and
your internal systems.

```
┌─────────────────────┐          ┌────────────────────────────────┐
│  Serviceware Cloud   │          │      Your Network (DMZ)        │
│                     │          │                                │
│   ┌─────────────┐   │  WSS:443 │   ┌──────────────────────┐    │
│   │   Gateway   │◄──┼──────────┼───│   Cloud Connector    │    │
│   └─────────────┘   │ (outbound)   │   (Docker Container) │    │
│                     │          │   └──────────────────────┘    │
└─────────────────────┘          │              │                 │
                                 │              ▼                 │
                                 │   ┌──────────────────────┐    │
                                 │   │   Your internal      │    │
                                 │   │   systems (ERP,      │    │
                                 │   │   AD, APIs, ...)     │    │
                                 │   └──────────────────────┘    │
                                 └────────────────────────────────┘
```

**Important:** The Cloud Connector initiates the connection – no inbound ports
are required.

---

## Prerequisites

### Software

| Component      | Minimum Version | Recommended |
| -------------- | --------------- | ----------- |
| Docker         | 20.10           | 24.x        |
| Docker Compose | 2.0             | 2.24+       |

**Alternative:** Kubernetes with Helm (see
[Kubernetes Deployment](#kubernetes-deployment))

### Resources

| Resource | Minimum | Recommended |
| -------- | ------- | ----------- |
| CPU      | 1 Core  | 2 Cores     |
| RAM      | 256 MB  | 512 MB      |
| Disk     | 100 MB  | 500 MB      |

### Provided by Serviceware

You will receive from Serviceware:

- **WebSocket URL** – The connection URL to the Serviceware Cloud
  (`wss://cloud.serviceware.se/connector/ws?tenant=your-tenant`)
- **Tenant ID** – Your unique tenant identifier

---

## Network Requirements

### Outbound Connections (required)

| Destination            | Port | Protocol  | Description           |
| ---------------------- | ---- | --------- | --------------------- |
| `cloud.serviceware.se` | 443  | WSS/HTTPS | Serviceware Cloud     |
| `ghcr.io` (one-time)   | 443  | HTTPS     | Docker Image Download |

### Internal Connections (depending on integration)

The Cloud Connector must be able to reach the internal systems you want to
connect:

| Example                 | Typical Port |
| ----------------------- | ------------ |
| Active Directory (LDAP) | 389 / 636    |
| SAP Gateway (OData)     | 443 / 8443   |
| REST APIs               | variable     |
| Databases               | variable     |

Network reachability alone does not grant access. The Cloud Connector blocks all
workload HTTP URLs until they are explicitly permitted by
`OUTBOUND_URL_ALLOWLIST`. The Serviceware Cloud OAuth/WebSocket control-plane connection
is not part of this workload allowlist.

### Proxy Support

If your network requires an HTTP proxy, set:

```bash
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1,internal-api
```

---

## Installation

### Step 1: Create Working Directory

```bash
mkdir -p /opt/cloud-connector
cd /opt/cloud-connector
```

### Step 2: Download Starter Template

```bash
# Option A: Git Clone (recommended)
git clone https://github.com/serviceware/cloud-connector-templates.git .

# Option B: Manual download
# Download the starter template from your Serviceware contact
```

### Step 3: Verify Project Structure

After download, the following structure should be present:

```
/opt/cloud-connector/
├── deno.json
├── docker-compose.yml
├── .env.example
└── functions/
    ├── health.ts
    ├── users/
    │   ├── index.ts
    │   └── [id].ts
    └── proxy/
        └── [...path].ts
```

---

## Configuration

### Step 1: Create Environment Variables

```bash
cp .env.example .env
```

### Step 2: Edit .env File

```bash
nano .env  # or your preferred editor
```

**Required fields:**

```env
# WebSocket URL to the Serviceware Cloud (provided by Serviceware)
SERVICEWARE_WS_URL=wss://cloud.serviceware.se/connector/ws?tenant=your-tenant
```

**Optional fields (depending on integration):**

```env
# For proxy function to internal APIs
INTERNAL_API_URL=http://your-internal-api:3000
INTERNAL_API_TOKEN=your-secret-api-token

# Required for every workload target. JSON array of regular expressions.
# Empty or omitted means deny all; [".*"] explicitly permits every URL.
OUTBOUND_URL_ALLOWLIST=["^http://your-internal-api:3000(?:/|$)"]

# For Active Directory integration
AD_SERVER=ldap://dc01.corp.example.com
AD_BASE_DN=DC=corp,DC=example,DC=com
AD_BIND_USER=CN=svc_serviceware,OU=Service,DC=corp,DC=example,DC=com
AD_BIND_PASSWORD=your-password

# For SAP integration
ERP_URL=https://sap-gateway.example.com
ERP_USER=svc_serviceware
ERP_PASSWORD=your-password
```

### Step 3: Set Permissions

```bash
# Protect .env file (only readable by root)
chmod 600 .env

# Functions directory (read-only for container)
chmod -R 755 functions/
```

---

## Creating Functions

Functions are TypeScript files in the `functions/` directory. The file structure
directly corresponds to URL paths.

### Routing Conventions

| File                           | URL Path     | Description         |
| ------------------------------ | ------------ | ------------------- |
| `functions/health.ts`          | `/health`    | Simple endpoint     |
| `functions/users/index.ts`     | `/users`     | Collection endpoint |
| `functions/users/[id].ts`      | `/users/:id` | Dynamic path        |
| `functions/files/[...path].ts` | `/files/*`   | Catch-all path      |

### Example: Simple Endpoint

```typescript
// functions/health.ts
import { http } from "@serviceware/cloud-connector-sdk";

export default http()
  .get((ctx) => {
    return ctx.res.ok().json({
      status: "ok",
      timestamp: ctx.startedAt,
    });
  });
```

### Example: CRUD Endpoint

```typescript
// functions/users/index.ts
import { defineHttp } from "@serviceware/cloud-connector-sdk";

export default defineHttp({
    // GET /users
    get: (ctx) => {
        const department = ctx.req.query.get("department");
        // ... load users from your data source ...
        return ctx.res.ok().json({ users: [...] });
    },

    // POST /users
    post: async (ctx) => {
        const body = await ctx.req.body.json<{ name: string; email: string }>();
        // ... create user ...
        return ctx.res.created().json({ id: "123", ...body });
    },
});
```

### Example: Proxy to Internal API

```typescript
// functions/proxy/[...path].ts
import { defineHttp } from "@serviceware/cloud-connector-sdk";

export default defineHttp({
  all: async (ctx) => {
    const internalUrl = ctx.env.INTERNAL_API_URL;
    return ctx.proxy
      .to(internalUrl)
      .stripPrefix("/proxy")
      .forwardHeaders()
      .bearer(ctx.env.INTERNAL_API_TOKEN)
      .send();
  },
});
```

### Handler Context API

```typescript
// Request information
ctx.requestId; // Request UUID
ctx.startedAt; // ISO 8601 timestamp
ctx.req.method; // HTTP method
ctx.req.url; // URL object
ctx.req.params.get("id"); // URL parameters
ctx.req.query.get("department"); // URLSearchParams
ctx.req.headers; // Request headers
ctx.env; // Environment variables
ctx.req.raw; // Original Request object
ctx.res; // Response factory
ctx.proxy; // HTTP proxy builder
ctx.upstream("https://internal.example"); // Upstream request builder

// Read body
await ctx.req.body.json<T>(); // Parse JSON
await ctx.req.body.text(); // As text
await ctx.req.body.formData(); // As FormData

// Create responses
ctx.res.ok().json(data); // JSON response (200)
ctx.res.created().json(data); // With status code
ctx.res.ok().text("Hello"); // Text response
ctx.res.noContent(); // 204 No Content
ctx.res.notFound("Not found"); // Error response
```

---

## YAML Functions (optional)

For simple proxy scenarios, you can use **YAML Functions** – completely without
TypeScript.

### Example: YAML Proxy

```yaml
# functions/api/index.yml
target: "{{ env.INTERNAL_API_URL }}"

request:
  headers:
    set:
      authorization: "Bearer {{ env.INTERNAL_API_TOKEN }}"
  url:
    prefix: "/api/v2"

response:
  headers:
    remove:
      - x-internal-debug
```

### Schema Validation in VS Code

For autocompletion, add at the beginning of the YAML file:

```yaml
# yaml-language-server: $schema=../../schemas/yaml-function.schema.json
target: "{{ env.API_URL }}"
```

### When to use YAML vs TypeScript?

| Scenario                      | YAML | TypeScript |
| ----------------------------- | ---- | ---------- |
| Simple proxy with auth        | ✅   | ○          |
| Transform headers/URL         | ✅   | ✅         |
| Complex business logic        | ❌   | ✅         |
| Load data from DB/cache       | ❌   | ✅         |
| Multiple backend calls        | ❌   | ✅         |
| Manipulate response body JSON | ❌   | ✅         |

---

## Starting and Testing

### Start Container

```bash
# In foreground (for testing)
docker-compose up

# In background (production)
docker-compose up -d
```

### Check Status

```bash
# Container status
docker-compose ps

# View logs
docker-compose logs -f

# Health check
curl http://localhost:8080/health
```

### Example Requests

```bash
# Health check
curl http://localhost:8080/health

# Get users (if users/ function exists)
curl http://localhost:8080/users

# Create user
curl -X POST http://localhost:8080/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Test User", "email": "test@example.com"}'
```

### Stop Container

```bash
docker-compose down
```

---

## Production Operation

### Automatic Restart

The `docker-compose.yml` already contains:

```yaml
restart: unless-stopped
```

### Systemd Service (optional)

For automatic start on system boot:

```bash
# /etc/systemd/system/cloud-connector.service
[Unit]
Description=Cloud Connector
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/cloud-connector
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl enable cloud-connector
sudo systemctl start cloud-connector
```

### Logging

Logs are output via Docker's logging driver:

```bash
# Last 100 lines
docker-compose logs --tail=100

# Live logs
docker-compose logs -f

# Export logs to file
docker-compose logs > /var/log/cloud-connector.log
```

### Updates

```bash
# Pull latest image
docker-compose pull

# Restart container
docker-compose up -d
```

---

## Troubleshooting

### Connection Problems

**Problem:** Cloud Connector does not connect to the Serviceware Cloud

```bash
# Test WebSocket connection
curl -v https://cloud.serviceware.se

# Check DNS resolution
nslookup cloud.serviceware.se

# Check firewall rules
telnet cloud.serviceware.se 443
```

**Solution:** Ensure that outbound connections to `cloud.serviceware.se:443` are
allowed.

### Container Does Not Start

**Problem:** Container starts and stops immediately

```bash
# Check logs
docker-compose logs cloud-connector

# Container status
docker-compose ps -a
```

**Common causes:**

- Missing or invalid `.env` file
- Invalid `SERVICEWARE_WS_URL`
- Missing `functions/` files

### Function Errors

**Problem:** Function returns errors

```bash
# Request with verbose output
curl -v http://localhost:8080/health

# Container logs during request
docker-compose logs -f
```

**Common causes:**

- Syntax errors in TypeScript files
- Missing environment variables
- Unreachable backend systems

### Health Check Fails

**Problem:** Container is "unhealthy"

```bash
# Test health endpoint manually
curl http://localhost:8080/health

# Check internal network connectivity
docker-compose exec cloud-connector wget -O- http://localhost:8080/health
```

---

## Support

For questions or problems, contact your Serviceware representative or open a
support ticket in the Serviceware Portal.

---

## Appendix: Complete docker-compose.yml

```yaml
services:
  cloud-connector:
    image: ghcr.io/serviceware/cloud-connector:3.0.0
    container_name: serviceware-cloud-connector
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - CLOUD_CONNECTOR_WS_URL=${SERVICEWARE_WS_URL}
      - CLOUD_CONNECTOR_FUNCTIONS_DIR=/functions
      - OUTBOUND_URL_ALLOWLIST=${OUTBOUND_URL_ALLOWLIST:-[]}
      # Your additional environment variables here
    volumes:
      - ./functions:/functions:ro
    healthcheck:
      test: [
        "CMD",
        "wget",
        "-q",
        "--spider",
        "http://localhost:8080/health",
      ]
      interval: 30s
      timeout: 5s
      retries: 3
```

---

## Appendix: .env.example

```env
# Required: WebSocket URL to the Serviceware Cloud
SERVICEWARE_WS_URL=wss://cloud.serviceware.se/connector/ws?tenant=your-tenant

# Optional: Internal API connection
INTERNAL_API_URL=http://your-internal-api:3000
INTERNAL_API_TOKEN=your-secret-token

# Default deny: add one anchored regex per permitted HTTP target
OUTBOUND_URL_ALLOWLIST=[]

# Optional: Active Directory
AD_SERVER=ldap://dc01.corp.example.com
AD_BASE_DN=DC=corp,DC=example,DC=com
AD_BIND_USER=CN=svc_serviceware,OU=Service,DC=corp,DC=example,DC=com
AD_BIND_PASSWORD=your-password

# Optional: SAP/ERP
ERP_URL=https://sap-gateway.example.com
ERP_USER=svc_serviceware
ERP_PASSWORD=your-password
```
