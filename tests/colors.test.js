import { describe, it, expect } from 'vitest'
import { fracColor } from '../src/lib/colors.js'

describe('fracColor', () => {
  it('hits the anchor colors', () => {
    expect(fracColor(0)).toBe('rgb(255,77,94)') // empty → red
    expect(fracColor(0.3)).toBe('rgb(255,176,32)') // low → amber
    expect(fracColor(0.6)).toBe('rgb(46,230,166)') // healthy → green
    expect(fracColor(1)).toBe('rgb(46,230,166)')
  })

  it('interpolates linearly between stops', () => {
    expect(fracColor(0.15)).toBe('rgb(255,127,63)') // halfway red → amber
  })

  it('clamps out-of-range input', () => {
    expect(fracColor(-5)).toBe(fracColor(0))
    expect(fracColor(7)).toBe(fracColor(1))
  })
})
