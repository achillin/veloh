import { describe, it, expect } from 'vitest'
import { holidayName, dayType } from '../src/lib/holidays.js'

describe('holidayName', () => {
  it('knows the fixed Luxembourg holidays', () => {
    expect(holidayName(new Date(2026, 0, 1))).toBe("New Year's Day")
    expect(holidayName(new Date(2026, 4, 1))).toBe('Labour Day')
    expect(holidayName(new Date(2026, 4, 9))).toBe('Europe Day')
    expect(holidayName(new Date(2026, 5, 23))).toBe('National Day')
    expect(holidayName(new Date(2026, 7, 15))).toBe('Assumption')
    expect(holidayName(new Date(2026, 10, 1))).toBe("All Saints' Day")
    expect(holidayName(new Date(2026, 11, 25))).toBe('Christmas Day')
    expect(holidayName(new Date(2026, 11, 26))).toBe("St Stephen's Day")
  })

  it('computes Easter-based holidays across years', () => {
    // Easter Sundays: 2024-03-31, 2025-04-20, 2026-04-05
    expect(holidayName(new Date(2024, 3, 1))).toBe('Easter Monday')
    expect(holidayName(new Date(2025, 3, 21))).toBe('Easter Monday')
    expect(holidayName(new Date(2026, 3, 6))).toBe('Easter Monday')
    expect(holidayName(new Date(2026, 4, 14))).toBe('Ascension Day') // Easter + 39
    expect(holidayName(new Date(2026, 4, 25))).toBe('Whit Monday') // Easter + 50
  })

  it('returns null on ordinary days', () => {
    expect(holidayName(new Date(2026, 6, 8))).toBeNull()
    expect(holidayName(new Date(2026, 3, 5))).toBeNull() // Easter Sunday itself is not listed
  })
})

describe('dayType', () => {
  it('classifies weekdays, Saturdays and Sundays', () => {
    expect(dayType(new Date(2026, 6, 8))).toBe('wd') // Wednesday
    expect(dayType(new Date(2026, 6, 11))).toBe('sat') // Saturday
    expect(dayType(new Date(2026, 6, 12))).toBe('sun') // Sunday
  })

  it('treats public holidays as Sundays', () => {
    expect(dayType(new Date(2026, 5, 23))).toBe('sun') // National Day, a Tuesday
  })
})
