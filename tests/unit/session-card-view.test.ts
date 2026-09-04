import { expect, test } from "bun:test";
import { SESSION_CARD_VIEW, SESSION_CARD_VIEWS, isSessionCardView } from "../../public/app-action-controller.ts";

test("session card view accepts only its closed presentation domain", () => {
  expect(SESSION_CARD_VIEW).toEqual({ ALL: "all", IDLE: "idle" });
  expect(SESSION_CARD_VIEWS).toEqual([SESSION_CARD_VIEW.ALL, SESSION_CARD_VIEW.IDLE]);
  expect(isSessionCardView(SESSION_CARD_VIEW.ALL)).toBe(true);
  expect(isSessionCardView(SESSION_CARD_VIEW.IDLE)).toBe(true);
  expect(isSessionCardView("invalid")).toBe(false);
});
