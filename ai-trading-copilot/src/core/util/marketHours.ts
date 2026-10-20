// London Stock Exchange trading hours, evaluated in Europe/London time.

/** English bank holidays when the LSE is closed (extend each year; the broker schedule is preferred when available). */
const LSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28",
]);

export interface LondonTime {
  date: string; // yyyy-mm-dd
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

export function londonTime(t: number): LondonTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: wd, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export interface MarketClock {
  /** Regular session open (orders can fill). */
  isOpen(t: number): boolean;
  /** Safe window for NEW entries: avoids the opening auction and the last half hour. */
  entriesAllowed(t: number): boolean;
  describe(t: number): string;
}

/** Simple LSE clock: weekdays 08:00–16:30 London, closed on listed bank holidays. */
export class LseClock implements MarketClock {
  constructor(private readonly entryStart = 8 * 60 + 15, private readonly entryEnd = 16 * 60) {}
  private tradingDay(l: LondonTime) {
    return l.weekday >= 1 && l.weekday <= 5 && !LSE_HOLIDAYS.has(l.date);
  }
  isOpen(t: number) {
    const l = londonTime(t);
    return this.tradingDay(l) && l.minutes >= 8 * 60 && l.minutes < 16 * 60 + 30;
  }
  entriesAllowed(t: number) {
    const l = londonTime(t);
    return this.tradingDay(l) && l.minutes >= this.entryStart && l.minutes < this.entryEnd;
  }
  describe(t: number) {
    const l = londonTime(t);
    if (!this.tradingDay(l)) return "LSE closed today";
    return this.isOpen(t) ? "LSE open" : "LSE closed (opens 08:00 UK time)";
  }
}

/** Always open – used by the simulator so the demo keeps moving. */
export const ALWAYS_OPEN: MarketClock = { isOpen: () => true, entriesAllowed: () => true, describe: () => "Simulated market (always open)" };

function isTradingDate(date: string): boolean {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5 && !LSE_HOLIDAYS.has(date);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * How many completed LSE sessions are missing after `lastBarDate`.
 * Today's session counts as completed only after 17:30 London (data lag).
 */
export function sessionsBehind(lastBarDate: string, now: number): number {
  const l = londonTime(now);
  let end = l.minutes >= 17 * 60 + 30 ? l.date : addDays(l.date, -1);
  let n = 0;
  for (let d = end; d > lastBarDate && n < 30; d = addDays(d, -1)) if (isTradingDate(d)) n++;
  return n;
}
