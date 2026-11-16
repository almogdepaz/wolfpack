import { expect, test } from "bun:test";
import { createFocusUiLog } from "../../public/focus-ui-log";
import { FOCUS_UI_ACTION as A, FOCUS_UI_SETTINGS as S, type FocusUiEvent } from "../../src/focus-ui-log";
function fixture() {
  let time = Date.parse("2026-11-16T12:00:00.000Z"), tick: (() => void) | undefined, target: string | undefined = "http://home/api/focus/ui-events";
  const sent: { url: string; body: { events: FocusUiEvent[] }; leaving: boolean }[] = [];
  let ids = 0;
  const log = createFocusUiLog({ target: () => target, now: () => time, elapsed: () => time, id: () => `visit-${++ids}`,
    schedule: fn => { tick = fn; return fn; }, cancel: () => { tick = undefined; },
    send: (url, body, leaving) => { sent.push({ url, body: JSON.parse(body), leaving }); },
  });
  return { log, sent, advance(ms: number) { time += ms; }, tick() { tick?.(); }, target(url?: string) { target = url; } };
}
test("client logs visible visits with duration, ordered exposures only on change, and leave flush", () => {
  const f = fixture(); const card = { session: "work", sessionId: "id", machine: "local", rank: 1, kind: "action" as const, reason: "rules" as const };
  f.log.setVisible(true, true); f.log.shown([card]); f.log.shown([card]); f.advance(1200); f.log.setVisible(true, false); f.log.setVisible(false, false);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.leaving).toBe(true);
  expect(f.sent[0]!.body.events.map(e => e.action)).toEqual([A.OPEN, A.VIEW, A.SHOWN, A.VIEW, A.LEFT]);
  expect(f.sent[0]!.body.events.at(-1)).toMatchObject({ visibleMs: 1200 });
  f.advance(2000); f.log.setVisible(true, true); f.log.shown([card]); f.tick();
  expect(f.sent[1]!.body.events[0].visit).not.toBe(f.sent[0]!.body.events[0].visit);
  expect(f.sent[1]!.body.events.map(e => e.action)).toEqual([A.OPEN, A.VIEW, A.SHOWN]);
});
test("pending home does not consume the first visible visit or exposure", () => {
  const f = fixture(); f.target();
  f.log.setVisible(true, true); f.log.shown([]);
  f.target("http://home/api/focus/ui-events"); f.log.setVisible(true, true); f.log.shown([]); f.tick();
  expect(f.sent[0]!.body.events.map(e => e.action)).toEqual([A.OPEN, A.VIEW, A.SHOWN]);
});
test("batch count, byte bounds, home fencing, timer, and failure dropping", async () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) f.log.record({ action: A.SETTINGS, control: S.OPEN });
  expect(f.sent[0]!.body.events).toHaveLength(32); f.tick(); expect(f.sent[1]!.body.events).toHaveLength(8);
  f.log.record({ action: A.OPEN }); f.target("http://other/api/focus/ui-events"); f.log.flush(); expect(f.sent).toHaveLength(2);
  f.log.record({ action: A.OPEN }); f.log.flush(); expect(f.sent.at(-1)!.url).toContain("other");
  f.target(); f.log.record({ action: A.OPEN }); f.log.flush(); expect(f.sent).toHaveLength(3);
  const fail = createFocusUiLog({ target: () => "local", send: () => { throw new Error("offline"); }, schedule: () => 1, cancel: () => {} });
  fail.record({ action: A.OPEN }); expect(() => fail.flush()).not.toThrow(); expect(() => fail.flush(true)).not.toThrow();
  const reject = createFocusUiLog({ target: () => "local", send: () => Promise.reject(new Error("offline")), schedule: () => 1, cancel: () => {} });
  reject.record({ action: A.OPEN }); reject.flush(); await Promise.resolve();
});
