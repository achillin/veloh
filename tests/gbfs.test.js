import { describe, it, expect } from 'vitest'
import { mergeStations } from '../src/lib/gbfs.js'

const info = {
  data: {
    stations: [
      {
        station_id: '1',
        name: [{ text: '#00001-LEON XIII', language: 'fr' }],
        address: 'Rue de Bonnevoie 103',
        lat: 49.598,
        lon: 6.137,
        capacity: 20,
      },
      {
        station_id: '2',
        name: [{ text: '#00002-GARE CENTRALE 2', language: 'fr' }],
        lat: 49.601,
        lon: 6.133,
        capacity: 21,
      },
      {
        station_id: '3',
        name: [{ text: '#00003-GHOST', language: 'fr' }],
        lat: 49.6,
        lon: 6.13,
        capacity: 10,
      },
      {
        station_id: '4',
        name: [{ text: '#00004-NOT INSTALLED', language: 'fr' }],
        lat: 49.6,
        lon: 6.13,
        capacity: 10,
      },
    ],
  },
}

const status = {
  data: {
    stations: [
      {
        station_id: '1',
        num_vehicles_available: 2,
        num_docks_available: 7,
        num_vehicles_disabled: 7,
        is_installed: true,
        is_renting: true,
        is_returning: true,
        last_reported: '2026-07-11T01:06:47Z',
      },
      {
        station_id: '2',
        num_vehicles_available: 9,
        num_docks_available: 4,
        num_vehicles_disabled: 5,
        is_installed: true,
        is_renting: false,
        is_returning: true,
        last_reported: null,
      },
      // station 3 missing from status on purpose
      {
        station_id: '4',
        num_vehicles_available: 1,
        num_docks_available: 1,
        num_vehicles_disabled: 0,
        is_installed: false,
        is_renting: false,
        is_returning: false,
      },
    ],
  },
}

describe('mergeStations', () => {
  const merged = mergeStations(info, status)

  it('joins information and status by station id', () => {
    expect(merged.map((s) => s.id)).toEqual(['1', '2'])
    const s1 = merged[0]
    expect(s1).toMatchObject({ bikes: 2, docks: 7, disabled: 7, capacity: 20, renting: true })
    expect(s1.lastReported).toEqual(new Date('2026-07-11T01:06:47Z'))
  })

  it('strips the "#NNNNN-" prefix from display names', () => {
    expect(merged[0].name).toBe('LEON XIII')
    expect(merged[1].name).toBe('GARE CENTRALE 2')
  })

  it('drops stations missing from status or not installed', () => {
    expect(merged.find((s) => s.id === '3')).toBeUndefined()
    expect(merged.find((s) => s.id === '4')).toBeUndefined()
  })

  it('defaults address and lastReported when absent', () => {
    expect(merged[1].address).toBe('')
    expect(merged[1].lastReported).toBeNull()
  })
})
