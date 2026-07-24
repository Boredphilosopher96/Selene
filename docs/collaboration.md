# Collaboration service

Selene’s collaboration package is optional. The desktop and static web apps
continue to use local persistence with no account, database, or network
dependency. `@selene/collaboration` adds a port-driven service only for teams
that choose shared review.

## Domain and authorization

Projects belong to organizations; users and memberships reserve fields for OIDC
or SAML subjects and RBAC roles (`owner`, `admin`, `editor`, `commenter`,
`viewer`, and `guest`). The PostgreSQL adapter resolves every authenticated
action through an active organization membership: owners/admins can delete,
owners/admins/editors can create and change designs or manage sharing,
commenters can comment, and viewers/guest members are read-only. Approval is
limited to owners, admins, and editors.
Signed guest capabilities remain scoped to one project and either viewer or
commenter permission.
The bundled proxy adapter accepts `x-selene-user-id` only when the request also
contains a server-only `x-selene-proxy-secret` matching
`COLLABORATION_PROXY_SECRET`. Strip both headers at the public edge, inject
them only after OIDC/SAML/session verification, and rotate the shared secret
through your secret manager. The injected user ID must be Selene's internal
user UUID after provisioning/mapping the external subject; browser-provided
identity and role headers are discarded.

Each save is an immutable revision. Threads reference a revision, a stable
`data-selene-node-id`/React node ID, and a named scenario. Comments can reply
to one another, mention users, carry reactions, resolve a thread, and record
per-user approval decisions. Every write should append an audit event.

Spatial review threads are separate from source-node threads. They carry full
artifact, screen, revision-fingerprint, viewport, and optional scenario/state
evidence plus normalized point or region coordinates. A region must have
positive normalized width and height and remain entirely within `0..1`. A
mapped anchor also records complete source evidence; it is not inferred from a
React node. Review thread resolution is an immutable lifecycle transition from
`open` to `resolved`, and a resolved thread always includes both resolver and
timestamp. Replies must name an earlier message in that same thread.

## Storage, concurrency, and operations

The ordered migrations provide PostgreSQL tables, foreign keys,
checks, partial indexes, idempotency keys, and the project/revision unique
constraint. Run every ordered migration. The generated-design baseline
command locks the project row, then writes the revision, readiness projection,
semantic change, and idempotency response in one transaction.
Clients retry mutating requests with an `Idempotency-Key` header. The service
returns the originally stored response for a retry, including its generated ID.

Every successful mutation emits a durable event with an opaque, increasing
cursor. Reconnect with `GET /v1/projects/:id/events?after=<cursor>` (the
response supplies `nextCursor`), or use
`GET /v1/projects/:id/events/stream` for server-sent events and reconnect using
the SSE `Last-Event-ID`. The durable endpoint is the recovery path for dropped
streams and deployments; clients must not infer ordering from timestamps.

The Fetch-compatible service exposes health (`/healthz`), Prometheus text
metrics (`/metrics`), JSON validation, CORS allow-listing, and a small
per-client rate limiter. Put production rate limits, logs, authentication, and
authorization at the edge as well.

## Generated-design API and compatibility

`@selene/collaboration` exposes one repository command with three explicit,
discriminated transactions: `append-revision`, `mark-ready`, and
`append-revision-and-mark-ready`. This avoids optional-field combinations such
as a readiness transition with a semantic change. Both the in-memory adapter
and PostgreSQL adapter implement this command; callers can substitute either
without changing the domain contract.

`DesignReviewState` is the independently versioned
`selene-design-review-state/v1` portable read model. A project without a
baseline reports the draft/none state; a current baseline has no exact changes;
a stale baseline has exact changes and stale approvals. The parser accepts
`unknown` and validates nested baseline identity, readiness/intent agreement,
revision references, scope, evidence, provenance, timestamps, and exact
change ownership before exposing the read model. Collaboration snapshots remain
`selene-collaboration/v2`; `designReviewState` is optional only for imports
created before baseline persistence. New snapshots validate the field strictly
and reject inconsistent data rather than exposing it to callers.

Imports are bounded to 10 MiB and 10,000 records per aggregate, then validate
every nested aggregate, ownership reference, message parent, resolution pair,
anchor bound, and AI request transition before storage. The
service creates spatial review threads at
`POST /v1/projects/:id/review-threads` and resolves them at
`POST /v1/review-threads/:id/resolve`; its request parser preserves complete
mapped-source evidence rather than accepting a lossy subset.

Review clients can list by lifecycle, revision, screen, state, author, unread
status, or deep link; append replies, record per-message reactions and
read/unread state; and reopen or move a thread. The public
`clusterReviewThreads` utility uses a fixed normalized grid and stable sorting
to produce portable spatial clusters. Review deep links must be safe relative
paths or `https` URLs on a configured same-product origin. Moving requires a complete new anchor and validates its
revision evidence before it is persisted. Signed commenter links may use those
review operations, while design mutations remain authenticated-member actions.
Guest writes deliberately emit an event without a user actor and still pass
through the same request-rate limiter.

AI requests are created with an immutable provider snapshot, target anchor,
and base revision fingerprint. The project list endpoint and single-request
endpoint expose their durable history. Transitions support `start`, `apply`,
`fail`, `cancel`/`reject`, `retry`, and `undo`; `undo` is an auditable terminal
`undone` state with an immutable original applied result plus a separate
required compensating `undoResult` revision, fingerprint, diff, and completion
time. Both result references must resolve to immutable revisions in the same
project with matching fingerprints. Existing snapshots that predate `undoResult`
are normalized on import.
Developer annotations require one category—`development`,
`interaction`, `accessibility`, or `content`—have their own create/list API,
and are included in exports, separate from both review discussion and
executable agent work.

## Self-hosting

The runnable Bun service is `apps/collaboration-service`. It defaults to
PostgreSQL; set `COLLABORATION_STORE=memory` only for a standalone local demo.
Its header identity provider is deliberately replaceable—production hosts must
inject a verified OIDC/SAML/session identity before the service routes.

## Enterprise identity and administration

The provider-neutral `@selene/collaboration/identity` contract is versioned as
`selene-identity/v1`. It defines the stable organization, subject, membership,
and RBAC vocabulary together with ports for OIDC Authorization Code + PKCE,
server-side BFF sessions, SAML assertions, and SCIM directory events. Providers
map immutable provider subjects to Selene users; do not use an email address as
the subject key.

For OIDC, keep the PKCE verifier and state in a one-time server-side BFF
transaction, use `S256`, require the callback state to match exactly, and send
only opaque transaction/session IDs in secure, HttpOnly, SameSite cookies. The
BFF adapter—not the browser—exchanges the authorization code and validates
issuer, signatures, audience, nonce, expiry, and all token claims through a
maintained OIDC library. Never put tokens in URLs, audit records, local storage,
or a browser-readable cookie.

For SAML, pass the response to a maintained SAML library and provision only its
verified assertion. Selene intentionally does not parse XML or implement XML
signature verification. Apply the same rule to OIDC token validation: no
handwritten cryptography or signature verification is supported by this
contract.

SCIM adapters upsert active users and call `deprovisionUser` for `active:false`
or delete events. Deprovisioning must be idempotent so an IdP retry cannot
restore access or cause a failure. It should revoke active BFF sessions and
remove memberships in one transaction before reporting success.

Audit records must use `redactIdentityAuditEvent`; it removes access/refresh/ID
tokens, cookies, client secrets, PKCE verifiers, credentials, and SAML
assertions recursively. Retain only provider name, internal subject ID, action,
request ID, and outcome needed for administration.

For an account-free local demo or desktop-only deployment, opt in explicitly:

```sh
export COLLABORATION_STORE=memory
export COLLABORATION_AUTH_MODE=local
export COLLABORATION_LOCAL_USER_ID=local-user
```

Local mode is intentionally explicit and never trusts a browser identity
header. Do not set `COLLABORATION_AUTH_MODE=local` in a shared or internet-facing
deployment. The default `proxy` mode continues to require a trusted reverse
proxy secret.

```sh
export DATABASE_URL=postgres://selene:selene@localhost:5432/selene
export COLLABORATION_SHARE_SECRET='replace-with-at-least-32-random-characters'
export COLLABORATION_PROXY_SECRET='replace-with-another-32-character-secret'
export CORS_ORIGINS=https://review.example.test
bun run --cwd apps/collaboration-service migrate
bun run --cwd apps/collaboration-service start
```

For a container build from the repository root:

```sh
docker build -f apps/collaboration-service/Dockerfile -t selene-collaboration .
docker run --rm -p 8787:8787 --env DATABASE_URL --env COLLABORATION_SHARE_SECRET --env CORS_ORIGINS selene-collaboration
```

`/healthz` reports process health, while `/readyz` checks the configured
repository connection. The integration harness exercises the production HTTP
wrapping and the deterministic in-memory persistence adapter; use the migration
file plus the commands above against a real Postgres instance for deployment.

## Sharing, portability, and privacy

Guest links are signed, time-limited grants with either viewer or commenter
permission. The Bun host HMAC-signs and hashes each bearer token, stores only
the hash in `share_links`, and verifies its persisted, non-revoked record before
granting access. Revoke a link with `DELETE /v1/share-links/:id`; never log or
persist the returned raw token. Inject a production HMAC/Ed25519 signer through
`ShareTokenSigner` when replacing the host adapter.

`GET /v1/projects/:id/export` returns a portable collaboration snapshot;
`POST /v1/import` restores one. Backups should run that export for every
project, encrypt the resulting artifacts, test restore into an isolated
database, and retain only the window required by policy. Deletion uses the
repository’s `deleteProject` operation; production deployments should implement
an auditable soft-delete/retention job before physical erasure and remove any
object-store backups when the retention window ends.

All ordinary JSON writes are streamed and capped at 1 MiB by default; hosts
may lower `maxRequestBodyBytes` or `maxSnapshotBytes` in `ServiceOptions`.
