# Harness-neutral task adapter contract

Wolfpack is the canonical, content-blind task control plane. This document defines the mandatory boundary for a harness adapter; it does not claim that a routable harness has an installed or loaded adapter. The generated [control API schema](generated/control-api.schema.json) remains the canonical request, response, error, and limit contract.

## Terminology and responsibility split

A **routable session** is a live `pi`, `claude`, `codex`, `gemini`, or `cursor` session in Wolfpack's openable-harness taxonomy. Shell, unknown, and custom commands are not routable task targets and fail with `TARGET_NOT_AGENT`. A **conforming adapter** implements this contract. A **loaded/ready adapter** has separate operator evidence that it is installed and loaded in the target process. Durable gateway receipt proves neither model delivery nor adapter readiness.

Wolfpack owns identity and routable-harness policy, durable ledgers and inbox indexes, canonical events and transitions, authorization, event disposition, local and trusted-tailnet routing, bounded retry, timeout, retention, acknowledgment, and artifact provenance. An adapter owns native tool registration, safe receive-loop scheduling, structural insertion, replay/deduplication, rendering, and harness turn control. Skills teach operators and models when to use those interfaces; they do not own transport or task state.

## Mandatory and optional conformance profile

A conforming adapter must use durable `{taskId,eventId}` structural insertion evidence that survives restart and context compaction; serialize a session's receive loop (or atomically deduplicate before insertion); record receiver delivery only after that evidence exists; replay unincorporated events; stop its cursor at the first busy, failed, or unknown model-visible event; and fail closed on unknown model-visible events. Parent acceptance must explicitly name one independently verified terminal task.

Optional capabilities, such as idle wakeup, push subscription, native terminating tools, and custom rendering, must be declared per adapter. Their absence is not a gateway failure and must not be inferred from a durable receipt.

## Canonical event-action matrix

| Event family | Adapter inbox | Receiver `delivered` | Parent `ack` | Turn policy |
| --- | --- | --- | --- | --- |
| assignment | receiver | after receiver structural insertion | never | adapter-specific |
| question, answer, information | canonical destination | only when the canonical destination is the receiver, after receiver structural insertion | never | adapter-specific |
| cancel request | receiver | after receiver structural insertion | never | adapter-specific |
| completed, failed, cancelled, timed-out | parent | never | after independent verification | adapter-specific |
| receipt, delivery, ack, failure, late-terminal internals | none; history only | never | never | none |

Wolfpack's data-driven disposition is authoritative and filters internal records from adapter inbox responses, including historical ledgers. Adding a model-visible type requires changing the disposition, generated/schema contract where applicable, adapter fixtures, and compatibility notes. Older adapters must fail closed instead of discarding it.

## Adapter receive algorithm

For one session, run one single-flight receive operation: first verify that the harness is idle with no pending work, then read the persisted cursor and fetch the inbox. For each event, use the full durable session entry set to check `{taskId,eventId}` incorporation, not only active prompt context. Check idle/pending state both before and after status retrieval. If evidence already exists, retry receiver delivery acknowledgment without reinsertion. Otherwise structurally insert the rendered event, verify evidence, then record delivery for receiver-targeted events.

Advance and persist the cursor only after every visible event before it was incorporated or safely recognized as a documented legacy internal event. On busy state, failed insertion, or unknown model-visible type, leave the cursor before that event so restart/poll replay remains possible.

## Opaque assignment fields

Wolfpack schema-validates, persists, and federates `role`, `metadata`, `onCompletePrompt`, `context.summary`, and `context.refs` without inferring lifecycle behavior. Adapters may render fields according to their declared policy. Pi renders `role` as assignment guidance and renders structured context/ref metadata without reading refs; it does not inject `metadata` into prompts and renders `onCompletePrompt` only to the parent with a terminal event. Gateway warnings remain visible without changing state.

## Uncertain outcomes and reconciliation

Inbox visibility is not model insertion. `delivered` means receiver structural evidence exists; parent acknowledgment is a separate post-verification action. Gateway delivery is at-least-once, so adapters must make insertion replay-safe rather than claim exactly-once execution.

For an uncertain `send`, retry automatically only with the same idempotency key; otherwise inspect receipt/status first. `status` and `inbox` are read-only retries. `delivered` and `ack` may be retried after canonical inspection. Do not blindly retry uncertain `message`, `complete`, or `cancel` mutations: inspect canonical status/history and reconcile. Adapter request timeout does not change canonical task expiry.

## Gateway and harness readiness

Routability is identity policy, not capability discovery. Wolfpack does not register adapters, heartbeat them, lease them, infer model readiness, wake a harness, or inject terminal prompts. Operators establish adapter-loaded readiness separately. Pi-specific evidence remains `pi list` plus a fresh Pi start or completed `/reload`; see the [task gateway guide](task-gateway.md#live-peer-readiness-checklist).
