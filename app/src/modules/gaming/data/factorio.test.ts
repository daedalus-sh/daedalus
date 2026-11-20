import { describe, expect, it } from 'vitest'
import { factorioOptions } from './factorio'

describe('factorioOptions', () => {
  it('offers stable when it is past the pin', () => {
    expect(factorioOptions('2.1.23', '2.1.24')).toEqual([{ version: '2.1.24' }])
  })

  it('compares part by part, so 2.1.10 is past 2.1.9', () => {
    expect(factorioOptions('2.1.9', '2.1.10')).toEqual([{ version: '2.1.10' }])
  })

  it('offers nothing when the pin is stable or newer, or either is unknown', () => {
    expect(factorioOptions('2.1.24', '2.1.24')).toEqual([])
    expect(factorioOptions('2.2.1', '2.1.24')).toEqual([])
    expect(factorioOptions(null, '2.1.24')).toEqual([])
    expect(factorioOptions('2.1.24', null)).toEqual([])
  })
})
