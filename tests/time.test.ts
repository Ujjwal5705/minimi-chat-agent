import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDatePhrase,
  resolveDate,
  validTimezone,
} from "../server/time.js";

const now = new Date("2026-11-20T15:00:00Z");
test("weekday recall uses past Tuesday in the user timezone", () => {
  const range = resolveDate("last Tuesday", now, "Asia/Kolkata")!;
  assert.equal(range.localDate, "2026-11-17");
  assert.equal(range.start, "2026-11-16T18:30:00.000Z");
  assert.equal(range.end, "2026-11-17T18:30:00.000Z");
});
test("last Monday excludes today; on Monday can mean today", () => {
  const monday = new Date("2026-11-16T12:00:00Z");
  assert.equal(
    resolveDate("last Monday", monday, "UTC")?.localDate,
    "2026-11-09",
  );
  assert.equal(
    resolveDate("on Monday", monday, "UTC")?.localDate,
    "2026-11-16",
  );
});
test("a yearless date resolves to the latest past occurrence", () => {
  assert.equal(resolveDate("3 November", now, "UTC")?.localDate, "2026-11-03");
  assert.equal(resolveDate("3 December", now, "UTC")?.localDate, "2025-12-03");
  assert.equal(
    resolveDate("3 December 2027", now, "UTC")?.localDate,
    "2027-12-03",
  );
});
test("DST uses calendar day boundaries, not 24-hour subtraction", () => {
  const range = resolveDate("2026-03-08", now, "America/New_York")!;
  assert.equal(
    (Date.parse(range.end) - Date.parse(range.start)) / 3_600_000,
    23,
  );
});
test("yesterday can differ across the date line", () => {
  const boundary = new Date("2026-11-20T02:00:00Z");
  assert.equal(
    resolveDate("yesterday", boundary, "Asia/Kolkata")?.localDate,
    "2026-11-19",
  );
  assert.equal(
    resolveDate("yesterday", boundary, "America/Los_Angeles")?.localDate,
    "2026-11-18",
  );
});
test("extract date and validate timezone without accepting arbitrary input", () => {
  assert.equal(
    extractDatePhrase("What did I ask on 3 November? Is it correct today?"),
    "3 November",
  );
  assert.equal(validTimezone("Asia/Kolkata"), true);
  assert.equal(validTimezone("Mars/Olympus"), false);
  assert.equal(resolveDate("nonsense", now, "UTC"), null);
});
test("last week is previous Monday to Monday", () => {
  const range = resolveDate("last week", now, "UTC")!;
  assert.equal(range.start, "2026-11-09T00:00:00.000Z");
  assert.equal(range.end, "2026-11-16T00:00:00.000Z");
});
