---
"@serviceware/cloud-connector": patch
---

Close the previous platform connection when Serviceware AI Process Engine does
not answer the connector's close frame within one second. Before, that
connection stayed open after a reconnect and silently dropped requests the
platform still sent on it. A connection whose peer stays silent past the
heartbeat timeout is now replaced without waiting for the drain, close frames
carry code 1000 with a reason, and the Compose templates and `docker run`
example allow 35 seconds to stop so the drain can finish.
