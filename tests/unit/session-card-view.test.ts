import { expect, test } from "bun:test";
import { SESSION_CARD_VIEW, SESSION_CARD_VIEWS, isSessionCardView } from "../../public/app-action-controller.ts";

test("session card view accepts only its closed presentation domain", () => {
  expect(SESSION_CARD_VIEW).toEqual({ ALL: "all", NEED: "need", WORK: "work", IDLE: "idle", FAIL: "fail" });
  expect(SESSION_CARD_VIEWS).toEqual(Object.values(SESSION_CARD_VIEW));
  for (const view of SESSION_CARD_VIEWS) expect(isSessionCardView(view)).toBe(true);
  expect(isSessionCardView(SESSION_CARD_VIEW.ALL)).toBe(true);
  expect(isSessionCardView(SESSION_CARD_VIEW.IDLE)).toBe(true);
  expect(isSessionCardView("invalid")).toBe(false);
});
