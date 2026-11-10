/**
 * Session kill with teardown, and the child cleanup cascade (`POST /api/kill`
 * and parent death). Same machine only: the cascade reads and kills through
 * the local backend and never calls a peer. Each child's own recorded policy
 * decides; a child without one never cascades.
 */
import { createLogger, errMsg } from "../log.js";
import {
  CASCADE_OUTCOME,
  CHILD_CLEANUP,
  type CascadedChild,
} from "../session-cascade-contract.js";
import { SESSION_KILL_DISPOSITION, type SessionBackend, type SessionKillDisposition, type SessionListFact } from "./backend-contract.js";
import { forgetSessionObservation } from "./session-observation.js";
import { onSessionDeath } from "./session-death.js";
import { teardownPty } from "./websocket.js";

const log = createLogger("session-cascade");

type CascadeBackend = Pick<SessionBackend, "listSessionFacts" | "killSessionById">;

/** Bound on remembered handled sessions; UUIDs never repeat, so the oldest can go. */
const HANDLED_MEMORY = 1024;

/**
 * Sessions whose children a kill or a death already handles: the cycle and
 * double-kill guard. A route kill and the parent's exit frame can both fire.
 */
const handled = new Set<string>();

/** Claim a session; false when another kill or death already handles it. */
export function claimSessionCleanup(sessionId: string): boolean {
  if (handled.has(sessionId)) return false;
  handled.add(sessionId);
  if (handled.size > HANDLED_MEMORY) handled.delete(handled.values().next().value!);
  return true;
}

/** Release a claim whose work failed, so a later kill or death can retry it. */
export function releaseSessionCleanup(sessionId: string): void {
  handled.delete(sessionId);
}

/** The one kill teardown: PTY, observation state, then the backend kill by exact UUID. */
export async function killSessionWithTeardown(
  backend: Pick<SessionBackend, "killSessionById">,
  session: string,
  sessionId: string,
): Promise<SessionKillDisposition> {
  teardownPty(session);
  forgetSessionObservation(sessionId, session);
  return backend.killSessionById(sessionId);
}

/**
 * Kill the cascade children of a parent that was killed or died, then their
 * cascade children. Reads one session table; throws when it is unavailable.
 * A child listed dead, or one the backend reports gone at kill time, is
 * `already_gone`; its own cascade children still follow their policy. A child
 * whose kill fails keeps its children.
 */
export async function cascadeChildCleanup(backend: CascadeBackend, parentSessionId: string): Promise<CascadedChild[]> {
  const facts = await backend.listSessionFacts();
  const childrenByParent = new Map<string, SessionListFact[]>();
  for (const fact of facts) {
    const parent = fact.identity?.parentSession;
    if (!parent || parent.cleanup !== CHILD_CLEANUP.CASCADE) continue;
    const siblings = childrenByParent.get(parent.wolfpackSessionId) ?? [];
    siblings.push(fact);
    childrenByParent.set(parent.wolfpackSessionId, siblings);
  }
  const cascaded: CascadedChild[] = [];
  const visit = async (parentId: string): Promise<void> => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      const sessionId = child.identity!.wolfpackSessionId;
      if (!claimSessionCleanup(sessionId)) continue;
      if (!child.alive) {
        cascaded.push({ sessionId, session: child.name, outcome: CASCADE_OUTCOME.ALREADY_GONE });
      } else {
        try {
          const disposition = await killSessionWithTeardown(backend, child.name, sessionId);
          const outcome = disposition === SESSION_KILL_DISPOSITION.ALREADY_GONE ? CASCADE_OUTCOME.ALREADY_GONE : CASCADE_OUTCOME.KILLED;
          cascaded.push({ sessionId, session: child.name, outcome });
        } catch (error: unknown) {
          releaseSessionCleanup(sessionId);
          cascaded.push({ sessionId, session: child.name, outcome: CASCADE_OUTCOME.FAILED, reason: errMsg(error) });
          continue;
        }
      }
      await visit(sessionId);
    }
  };
  await visit(parentSessionId);
  return cascaded;
}

/** Cascade a parent's death. Logs each child at info with both IDs. */
async function cascadeParentDeath(backend: CascadeBackend, parentSessionId: string): Promise<void> {
  if (!claimSessionCleanup(parentSessionId)) return;
  try {
    for (const child of await cascadeChildCleanup(backend, parentSessionId)) {
      log.info("parent death cascade", {
        parentSessionId,
        childSessionId: child.sessionId,
        child: child.session,
        outcome: child.outcome,
        ...(child.reason !== undefined && { reason: child.reason }),
      });
    }
  } catch (error: unknown) {
    releaseSessionCleanup(parentSessionId);
    log.warn("parent death cascade failed: session table unavailable", { parentSessionId, error: errMsg(error) });
  }
}

/** Cascade on parent death; returns the stop function. */
export function startChildCleanupCascade(getBackend: () => CascadeBackend): () => void {
  return onSessionDeath((sessionId) => { void cascadeParentDeath(getBackend(), sessionId); });
}

export function __resetSessionCascadeForTests(): void {
  handled.clear();
}
