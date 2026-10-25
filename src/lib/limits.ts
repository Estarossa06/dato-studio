const MB = 1024 * 1024

export const MAX_CSV_BYTES = 50 * MB
export const LOW_MEMORY_CSV_BYTES = 25 * MB
export const MAX_XLSX_BYTES = 10 * MB

export function csvLimitForDevice(deviceMemory?: number): number {
  return deviceMemory !== undefined && deviceMemory >= 8 ? MAX_CSV_BYTES : LOW_MEMORY_CSV_BYTES
}

export function fileLimitForDevice(name: string, deviceMemory?: number): number | null {
  const extension = name.toLowerCase().split('.').pop()
  if (extension === 'xlsx') return MAX_XLSX_BYTES
  if (['csv', 'txt', 'tsv'].includes(extension ?? '')) return csvLimitForDevice(deviceMemory)
  return null
}
