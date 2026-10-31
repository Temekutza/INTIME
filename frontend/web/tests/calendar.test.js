import test from "node:test";
import assert from "node:assert/strict";
import { calendarRange, movePeriod, daySegments } from "../lib/calendar.js";
const event = (id, extra = {}) => ({ id, type: "meeting", title: "Встреча", date: "2026-10-30", time: "12:00", duration_min: 60, status: "planned", ...extra });

test("calendar clamps month/year navigation and weeks start Monday", () => {
  assert.equal(movePeriod("2026-01-31", "month", 1), "2026-02-28");
  assert.equal(movePeriod("2024-02-29", "year", 1), "2025-02-28");
  const week = calendarRange("2026-11-01", "week");
  assert.equal(week.start.getDay(), 1);
  assert.equal(week.start.getDate(), 26);
});
test("calendar splits overnight intervals and assigns separate overlap lanes", () => {
  const night = event(1, { date: "2026-10-30", time: "23:00", duration_min: 120 });
  const next = new Date(2026, 9, 31);
  const rows = daySegments([night, event(2, { date: "2026-10-31", time: "00:30", duration_min: 60 })], next);
  assert.equal(rows.length, 2); assert.equal(rows[0].start, next.getTime());
  assert.equal(rows[0].end - rows[0].start, 3600000);
  assert.equal(rows[0].lanes, 2); assert.notEqual(rows[0].lane, rows[1].lane);
});

test("short hit areas reserve lanes without inventing event duration", () => {
  const date = new Date(2026, 9, 31);
  const rows = daySegments([event(1, { date: "2026-10-31", time: "11:00", duration_min: 5 }), event(2, { date: "2026-10-31", time: "11:10", duration_min: 5 })], date, 40);
  assert.equal(rows[0].end - rows[0].start, 5 * 60000);
  assert.equal(rows[0].lanes, 2); assert.notEqual(rows[0].lane, rows[1].lane);
});
