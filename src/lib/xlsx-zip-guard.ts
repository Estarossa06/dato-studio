const MiB = 1024 * 1024

export const MAX_XLSX_ZIP_ENTRIES = 256
export const MAX_XLSX_ENTRY_BYTES = 32 * MiB
export const MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 64 * MiB

export interface ZipEntryForValidation {
  name: string
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localStart: number
  dataStart: number
  dataEnd: number
  localEnd: number
}

export function validateDeclaredXlsxSizes(sizes: number[], maxEntry = MAX_XLSX_ENTRY_BYTES, maxTotal = MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES): number {
  let total = 0
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0) throw zipError('tamaño descomprimido declarado inválido.')
    if (size > maxEntry) throw zipError(`una entrada supera el máximo de ${maxEntry / MiB} MiB descomprimidos.`)
    total += size
    if (total > maxTotal) throw zipError(`el contenido declarado supera el máximo total de ${maxTotal / MiB} MiB.`)
  }
  return total
}

function zipError(message: string): Error {
  return new Error(`El XLSX se rechazó durante la validación ZIP: ${message}`)
}

function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw zipError('estructura truncada o dañada.')
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw zipError('estructura truncada o dañada.')
  return view.getUint32(offset, true)
}

function sameBytes(bytes: Uint8Array, a: number, b: number, length: number): boolean {
  if (a < 0 || b < 0 || a + length > bytes.length || b + length > bytes.length) return false
  for (let index = 0; index < length; index++) if (bytes[a + index] !== bytes[b + index]) return false
  return true
}

function decodeName(bytes: Uint8Array, offset: number, length: number, utf8: boolean): string {
  if (!length || length > 1024 || offset < 0 || offset + length > bytes.length) throw zipError('nombre de entrada inválido.')
  let name: string
  try {
    name = new TextDecoder(utf8 ? 'utf-8' : 'ascii', { fatal: true }).decode(bytes.subarray(offset, offset + length))
  } catch {
    throw zipError('nombre de entrada con codificación inválida.')
  }
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) {
    throw zipError('nombre de entrada sospechoso.')
  }
  return name
}

function validateExtraFields(view: DataView, start: number, length: number): void {
  const end = start + length
  if (start < 0 || end > view.byteLength) throw zipError('campos adicionales truncados.')
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) throw zipError('campo adicional incompleto.')
    const id = readU16(view, offset)
    const fieldLength = readU16(view, offset + 2)
    offset += 4
    if (offset + fieldLength > end) throw zipError('longitud de campo adicional inválida.')
    if (id === 0x0001) throw zipError('no se admite ZIP64.')
    offset += fieldLength
  }
}

export function inspectXlsxZip(data: ArrayBuffer | Uint8Array): ZipEntryForValidation[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw zipError('firma de archivo no válida.')
  }

  const minEocd = Math.max(0, bytes.length - 22 - 0xffff)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= minEocd; offset--) {
    if (readU32(view, offset) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw zipError('no se encontró el directorio central ZIP.')
  const disk = readU16(view, eocd + 4)
  const centralDisk = readU16(view, eocd + 6)
  const diskEntries = readU16(view, eocd + 8)
  const entryCount = readU16(view, eocd + 10)
  const centralSize = readU32(view, eocd + 12)
  const centralOffset = readU32(view, eocd + 16)
  const commentLength = readU16(view, eocd + 20)
  if (eocd + 22 + commentLength !== bytes.length) throw zipError('hay datos finales o comentarios con longitud inconsistente.')
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw zipError('no se admiten archivos ZIP divididos en varios volúmenes.')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw zipError('no se admite ZIP64.')
  if (entryCount < 1 || entryCount > MAX_XLSX_ZIP_ENTRIES) throw zipError(`el número de entradas debe estar entre 1 y ${MAX_XLSX_ZIP_ENTRIES}.`)
  if (centralOffset + centralSize !== eocd) throw zipError('el directorio central tiene límites inconsistentes.')

  const entries: ZipEntryForValidation[] = []
  const names = new Set<string>()
  const declaredSizes: number[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (readU32(view, cursor) !== 0x02014b50) throw zipError('entrada del directorio central inválida.')
    const flags = readU16(view, cursor + 8)
    const method = readU16(view, cursor + 10)
    const crc32 = readU32(view, cursor + 16)
    const compressedSize = readU32(view, cursor + 20)
    const uncompressedSize = readU32(view, cursor + 24)
    const nameLength = readU16(view, cursor + 28)
    const extraLength = readU16(view, cursor + 30)
    const commentSize = readU16(view, cursor + 32)
    const diskStart = readU16(view, cursor + 34)
    const localOffset = readU32(view, cursor + 42)
    const nameStart = cursor + 46
    const entryEnd = nameStart + nameLength + extraLength + commentSize
    if (entryEnd > centralOffset + centralSize) throw zipError('directorio central truncado.')
    const name = decodeName(bytes, nameStart, nameLength, (flags & 0x0800) !== 0)
    validateExtraFields(view, nameStart + nameLength, extraLength)
    if (names.has(name)) throw zipError('hay nombres de entrada duplicados.')
    names.add(name)
    if (diskStart !== 0) throw zipError('se encontró una entrada en otro volumen ZIP.')
    if ((flags & (0x0001 | 0x0020 | 0x0040 | 0x2000)) !== 0) throw zipError('no se admiten entradas cifradas o con parches ZIP.')
    if ((flags & 0x0008) !== 0) throw zipError('no se admiten entradas con descriptor de datos; vuelve a guardar el libro como .xlsx.')
    if (method !== 0 && method !== 8) throw zipError('método de compresión ZIP no compatible.')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw zipError('no se admite ZIP64.')
    declaredSizes.push(uncompressedSize)
    validateDeclaredXlsxSizes(declaredSizes)

    if (readU32(view, localOffset) !== 0x04034b50) throw zipError('encabezado local de entrada inválido.')
    const localFlags = readU16(view, localOffset + 6)
    const localMethod = readU16(view, localOffset + 8)
    const localCrc = readU32(view, localOffset + 14)
    const localCompressed = readU32(view, localOffset + 18)
    const localUncompressed = readU32(view, localOffset + 22)
    const localNameLength = readU16(view, localOffset + 26)
    const localExtraLength = readU16(view, localOffset + 28)
    const localNameStart = localOffset + 30
    if (localFlags !== flags || localMethod !== method || localCrc !== crc32 || localCompressed !== compressedSize || localUncompressed !== uncompressedSize) {
      throw zipError('los tamaños o metadatos de encabezados ZIP no coinciden.')
    }
    if (localNameLength !== nameLength || !sameBytes(bytes, nameStart, localNameStart, nameLength)) throw zipError('el nombre del encabezado local no coincide.')
    validateExtraFields(view, localNameStart + localNameLength, localExtraLength)
    const dataStart = localNameStart + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralOffset || dataEnd > bytes.length) throw zipError('los datos de una entrada salen de sus límites.')
    if (method === 0 && compressedSize !== uncompressedSize) throw zipError('una entrada ZIP almacenada tiene tamaños inconsistentes.')
    entries.push({ name, method, crc32, compressedSize, uncompressedSize, localStart: localOffset, dataStart, dataEnd, localEnd: dataEnd })
    cursor = entryEnd
  }
  if (cursor !== centralOffset + centralSize) throw zipError('el tamaño del directorio central no coincide con sus entradas.')

  const sorted = [...entries].sort((a, b) => a.localStart - b.localStart)
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].localEnd > sorted[index].localStart) throw zipError('las entradas ZIP se solapan.')
  }
  return entries
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

function updateCrc(crc: number, chunk: Uint8Array): number {
  let result = crc
  for (const byte of chunk) result = (CRC_TABLE[(result ^ byte) & 0xff] ^ (result >>> 8)) >>> 0
  return result
}

export async function validateXlsxZipExpansion(data: ArrayBuffer | Uint8Array): Promise<{ entries: number; uncompressedBytes: number }> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const entries = inspectXlsxZip(bytes)
  if (typeof DecompressionStream === 'undefined') throw zipError('este navegador no permite validar la descompresión de forma acotada.')
  let totalOutput = 0

  for (const entry of entries) {
    let entryOutput = 0
    let crc = 0xffffffff
    if (entry.method === 0) {
      const chunk = bytes.subarray(entry.dataStart, entry.dataEnd)
      entryOutput = chunk.byteLength
      crc = updateCrc(crc, chunk)
    } else {
      let decompressor: DecompressionStream
      try { decompressor = new DecompressionStream('deflate-raw') }
      catch { throw zipError('este navegador no admite validar compresión deflate de forma acotada.') }
      const compressedBytes = Uint8Array.from(bytes.subarray(entry.dataStart, entry.dataEnd))
      const compressed = new Blob([compressedBytes])
      const reader = compressed.stream().pipeThrough(decompressor).getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          entryOutput += value.byteLength
          totalOutput += value.byteLength
          if (entryOutput > MAX_XLSX_ENTRY_BYTES || entryOutput > entry.uncompressedSize) {
            await reader.cancel()
            throw zipError('la salida real de una entrada excede el tamaño permitido o declarado.')
          }
          if (totalOutput > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES) {
            await reader.cancel()
            throw zipError(`la salida real supera el máximo total de ${MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES / MiB} MiB.`)
          }
          crc = updateCrc(crc, value)
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('El XLSX se rechazó')) throw error
        throw zipError('una entrada no pudo descomprimirse correctamente.')
      } finally {
        reader.releaseLock()
      }
    }
    if (entry.method === 0) totalOutput += entryOutput
    if (entryOutput !== entry.uncompressedSize) throw zipError('la salida real no coincide con el tamaño declarado.')
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw zipError('la suma de comprobación CRC de una entrada no coincide.')
    if (totalOutput > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES) throw zipError(`la salida real supera el máximo total de ${MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES / MiB} MiB.`)
  }
  return { entries: entries.length, uncompressedBytes: totalOutput }
}
