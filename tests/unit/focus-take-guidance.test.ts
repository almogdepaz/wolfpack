import { expect, test } from "bun:test";
import skill from "../../skills/wolfpack-focus/SKILL.md" with { type: "text" };

test("bundled focus skill teaches the optional take, retirement and dismissal rules without legacy summary instructions", () => {
  expect(skill).toContain("description: Maintain the user's durable focus intentions and next-action order through wolfpack focus.");
  expect(skill).toContain("the take is optional and usually absent.");
  expect(skill).toContain("a priority call across two or more cards, a risk or conflict between sessions, a pattern across episodes, or a question tied to no session. one line, at most 200 characters.");
  expect(skill).toContain("never restate a card, report session or machine status, or repeat what needs the user; the cards already say it.");
  expect(skill).toContain("`--about 1,3` names the rows of this file (1-based) the take depends on; it disappears when any of them resolves.");
  expect(skill).toContain("`wolfpack focus nudge` is retired: do not call it.");
  expect(skill).toContain("every `next` you write replaces the previous take; pass `--take` again only if the point still holds and still passes the take test. update other intention state only if activity changes what matters next.");
  expect(skill).toContain("a take is not memory and not a status report: durable context goes in `note`. `seenTakeAt` equal to `next.updatedAt` in `focus show` means the user dismissed it; do not repeat the same point unless the facts changed.");
  expect(skill).toContain("wolfpack focus next next.json --take 'Answer me-2 first; the release card depends on it.' --about 1,2 --json");
  expect(skill.match(/nudge/gu)).toHaveLength(1); // only the explicit retirement, never an active instruction/example
  expect(skill).toContain("mark the missing evidence in the reason, and never claim fresh knowledge");
});
