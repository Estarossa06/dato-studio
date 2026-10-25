import { describe, expect, it } from 'vitest'
import { csvLimitForDevice, fileLimitForDevice, LOW_MEMORY_CSV_BYTES, MAX_CSV_BYTES, MAX_XLSX_BYTES } from './limits'

describe('file limits', () => {
  it('uses the conservative CSV limit unless the device reports at least 8 GB', () => {
    expect(csvLimitForDevice(undefined)).toBe(LOW_MEMORY_CSV_BYTES)
    expect(csvLimitForDevice(4)).toBe(LOW_MEMORY_CSV_BYTES)
    expect(csvLimitForDevice(8)).toBe(MAX_CSV_BYTES)
  })

  it('maps supported extensions to the same limits used by the interface and worker', () => {
    for (const name of ['data.csv', 'data.txt', 'data.tsv']) expect(fileLimitForDevice(name, 8)).toBe(MAX_CSV_BYTES)
    expect(fileLimitForDevice('data.xlsx', 8)).toBe(MAX_XLSX_BYTES)
    expect(fileLimitForDevice('renamed.xls', 8)).toBeNull()
    expect(fileLimitForDevice('data.csv', 2)).toBe(LOW_MEMORY_CSV_BYTES)
  })
})
