import { createHash, randomBytes } from "node:crypto";

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 1_024;
interface TicketRecord { readonly expiresAt: number; readonly clientIp: string; }
const tickets = new Map<string, TicketRecord>();

function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("base64url");
}

function prune(now: number): void {
  for (const [key, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(key);
  }
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next().value as string | undefined;
    if (!oldest) break;
    tickets.delete(oldest);
  }
}

export function issueWebSocketTicket(clientIp: string, now = Date.now()): { ticket: string; expiresInMs: number } {
  prune(now);
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(digest(ticket), { clientIp, expiresAt: now + TICKET_TTL_MS });
  return { ticket, expiresInMs: TICKET_TTL_MS };
}

export function consumeWebSocketTicket(ticket: string, clientIp: string, now = Date.now()): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
  const key = digest(ticket);
  const record = tickets.get(key);
  tickets.delete(key);
  return Boolean(record && record.expiresAt > now && record.clientIp === clientIp);
}

export function __clearWebSocketTickets(): void { tickets.clear(); }
