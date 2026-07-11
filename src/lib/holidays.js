// Luxembourg public holidays, computed locally (no API needed).

// Anonymous Gregorian algorithm — returns Easter Sunday for a given year.
function easterSunday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

function plusDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

const mdKey = (d) => `${d.getMonth() + 1}-${d.getDate()}`

const holidayCache = new Map()

function holidaysForYear(year) {
  if (holidayCache.has(year)) return holidayCache.get(year)
  const easter = easterSunday(year)
  const map = new Map([
    ['1-1', "New Year's Day"],
    ['5-1', 'Labour Day'],
    ['5-9', 'Europe Day'],
    ['6-23', 'National Day'],
    ['8-15', 'Assumption'],
    ['11-1', "All Saints' Day"],
    ['12-25', 'Christmas Day'],
    ['12-26', "St Stephen's Day"],
  ])
  map.set(mdKey(plusDays(easter, 1)), 'Easter Monday')
  map.set(mdKey(plusDays(easter, 39)), 'Ascension Day')
  map.set(mdKey(plusDays(easter, 50)), 'Whit Monday')
  holidayCache.set(year, map)
  return map
}

/** Returns the holiday name for a date, or null. */
export function holidayName(date) {
  return holidaysForYear(date.getFullYear()).get(mdKey(date)) ?? null
}

/** 'wd' | 'sat' | 'sun' — public holidays count as Sundays for traffic patterns. */
export function dayType(date) {
  if (holidayName(date)) return 'sun'
  const dow = date.getDay()
  if (dow === 0) return 'sun'
  if (dow === 6) return 'sat'
  return 'wd'
}
