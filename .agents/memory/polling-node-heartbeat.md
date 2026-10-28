# Polling node heartbeat ownership

For `poll://` nodes, authenticated `/api/agent/poll` and accepted result callbacks
own device health, SIM validation and heartbeat timestamps. Queue wait success,
timeout, queue/database errors and manual dashboard ping must not write those
fields. A manual ping only reads stored telemetry. Task errors remain visible
as task/check results; they are not evidence of a new device contact.

Preserve monotonic task expiry and tenant/domain consensus rules in
`agentPollRoutes.js`; an expired callback must not revive a task or change a
domain verdict. Direct HTTP-node health behavior is separate.

Regression: `node --test scripts/test-pentagon-polling-heartbeat.cjs` exercises
the production handlers with isolated DB/queue/HTTP boundaries.

Node/task schema setup is shared once per process, including concurrent first
requests. Failed setup rejects callers and clears its promise for retry. Keep
DDL out of warm agent poll/result paths: repeated trans-Pacific DB round trips
were adding 12–16 seconds per poll. This does not cache authentication, node
activity, telemetry, network validation or task claims; those run per request.
Regression: `node --test scripts/test-pentagon-poll-schema-setup.cjs`.
