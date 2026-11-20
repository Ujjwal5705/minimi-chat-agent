import { DateTime, IANAZone } from "luxon";
import * as chrono from "chrono-node";
import type { DateRange } from "../shared/types.js";

export function validTimezone(zone: string): boolean {
  return zone === "UTC" || IANAZone.isValidZone(zone);
}

export function extractDatePhrase(text: string): string | null {
  const match = text.match(
    /\b(?:(?:last|on)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:yesterday|today|last week)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/i,
  );
  return match?.[0] ?? null;
}

/** Calendar arithmetic happens in the user's zone, including DST day boundaries. */
export function resolveDate(
  phrase: string | null,
  now: Date,
  zone: string,
): DateRange | null {
  if (!phrase || !validTimezone(zone)) return null;
  const local = DateTime.fromJSDate(now, { zone });
  const text = phrase
    .toLowerCase()
    .trim()
    .replace(/^on\s+/, "");
  let day = local.startOf("day");
  let end: DateTime | undefined;
  let assumption = "Calendar date in your timezone.";
  const weekdays = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const weekday = weekdays.indexOf(text.replace(/^last\s+/, "")) + 1;
  if (weekday) {
    let difference = (local.weekday - weekday + 7) % 7;
    if (text.startsWith("last ") && difference === 0) difference = 7;
    day = day.minus({ days: difference });
    assumption =
      "The most recent occurrence of this weekday; “last” excludes today.";
  } else if (text === "yesterday") {
    day = day.minus({ days: 1 });
  } else if (text === "last week") {
    day = day.startOf("week").minus({ weeks: 1 });
    end = day.plus({ weeks: 1 });
    assumption = "The previous Monday–Sunday calendar week in your timezone.";
  } else if (text !== "today") {
    // Give chrono a wall clock so its host timezone cannot change the interpretation.
    const wallClock = new Date(
      Date.UTC(local.year, local.month - 1, local.day, 12),
    );
    const result = chrono.casual.parse(
      text,
      { instant: wallClock, timezone: 0 },
      { forwardDate: false },
    )[0];
    if (!result) return null;
    const components = result.start;
    const explicitYear = components.isCertain("year");
    day = DateTime.fromObject(
      {
        year: explicitYear ? components.get("year")! : local.year,
        month: components.get("month")!,
        day: components.get("day")!,
      },
      { zone },
    );
    if (!day.isValid) return null;
    if (!explicitYear && day > local) {
      day = day.minus({ years: 1 });
      assumption = "No year was given; using the most recent past occurrence.";
    }
  }
  return {
    phrase,
    start: day.toUTC().toISO()!,
    end: (end ?? day.plus({ days: 1 })).toUTC().toISO()!,
    localDate: day.toISODate()!,
    assumption,
  };
}
