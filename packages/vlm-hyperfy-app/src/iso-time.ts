/**
 * Milliseconds since the epoch for the server's timestamps, without Date: Hyperfy's script sandbox gives Date only
 * `now`. Accepts exactly the shape `toISOString` emits, 'YYYY-MM-DDTHH:MM:SS.sssZ' (the millis are optional);
 * anything else, including an impossible date, is NaN.
 */
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/

const DAY_MS = 86_400_000

/** Days from 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export function parseIsoTime(s: unknown): number {
  if (typeof s !== 'string') return NaN
  const m = ISO.exec(s)
  if (!m) return NaN
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number)
  const ms = m[7] ? Number(m[7]) : 0
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return NaN
  const days = mo === 2 && isLeap(y) ? 29 : MONTH_DAYS[mo - 1]
  if (d < 1 || d > days) return NaN
  return daysFromCivil(y, mo, d) * DAY_MS + ((h * 60 + mi) * 60 + sec) * 1000 + ms
}
