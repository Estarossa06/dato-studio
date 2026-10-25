import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { analyzeDocument, applyRules, EMPTY_RULES } from './clean'
import { MAX_XLSX_BYTES } from './limits'
import { exportWorkbook, parseWorkbook } from './workbook'
import { inspectXlsxZip, MAX_XLSX_ENTRY_BYTES, MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES, MAX_XLSX_ZIP_ENTRIES, validateDeclaredXlsxSizes, validateXlsxZipExpansion } from './xlsx-zip-guard'

function fixtureWorkbook() {
  const workbook = XLSX.utils.book_new()
  const first = XLSX.utils.aoa_to_sheet([
    ['', 'ID', 'ID', 'Nota'],
    ['', { t: 's', v: '000742' }, { t: 'n', v: 45658, z: 'm/d/yy' }, ' Muñoz, "Ana"\nNorte '],
    ['', 'x', { t: 'n', v: 2, f: '1+1' }, ''],
  ])
  XLSX.utils.book_append_sheet(workbook, first, 'Datos')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['otro'], ['hoja']]), 'Otra')
  return workbook
}

function fixtureBytes() {
  return new Uint8Array(XLSX.write(fixtureWorkbook(), { bookType: 'xlsx', type: 'array' }) as ArrayBuffer)
}

function compressedFixtureBytes() {
  return new Uint8Array(XLSX.write(fixtureWorkbook(), { bookType: 'xlsx', type: 'array', compression: true }) as ArrayBuffer)
}

function findZipSignature(bytes: Uint8Array, signature: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset <= bytes.length - 4; offset++) if (view.getUint32(offset, true) === signature) return offset
  return -1
}

describe('XLSX workbook model', () => {
  it('lists sheets and dimensions and preserves empty and duplicate headers and text identifiers', async () => {
    const document = await parseWorkbook(fixtureBytes(), { name: 'muestra.xlsx', size: 1024 })
    expect(document.sheets).toEqual([{ name: 'Datos', rows: 3, columns: 4 }, { name: 'Otra', rows: 2, columns: 1 }])
    expect(document.originalHeaders).toEqual(['', 'ID', 'ID', 'Nota'])
    expect(document.rows[0][1]).toBe('000742')
    expect(document.xlsxCells?.[0][1].type).toBe('s')
    expect(analyzeDocument(document).emptyHeaders).toBe(1)
    expect(analyzeDocument(document).duplicateHeaders).toBe(1)
  })

  it('allows choosing a different sheet and handles an empty worksheet', async () => {
    const document = await parseWorkbook(fixtureBytes(), { name: 'muestra.xlsx', size: 1024, sheetName: 'Otra' })
    expect(document.sheetName).toBe('Otra')
    expect(document.rows).toEqual([['hoja']])
    const empty = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(empty, {}, 'Vacía')
    const bytes = XLSX.write(empty, { bookType: 'xlsx', type: 'array' }) as Uint8Array
    expect((await parseWorkbook(bytes, { name: 'vacío.xlsx', size: bytes.length })).rows).toEqual([])
  })

  it('can import a worksheet without treating its first row as a header', async () => {
    const document = await parseWorkbook(fixtureBytes(), { name: 'muestra.xlsx', size: 1024, hasHeader: false })
    expect(document.originalHeaders).toEqual([])
    expect(document.rows[0][0]).toBe('')
    expect(document.rows[0][1]).toBe('ID')
    expect(document.rows).toHaveLength(3)
  })

  it('keeps formula metadata inert and reports it without evaluating formulas', async () => {
    const document = await parseWorkbook(fixtureBytes(), { name: 'muestra.xlsx', size: 1024 })
    expect(document.xlsxCells?.[1][2].formula).toBe('1+1')
    expect(document.workbookWarnings?.some((warning) => warning.includes('no se recalculan'))).toBe(true)
  })

  it('warns about merged cells and integers outside JavaScript safe precision', async () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([[{ t: 'n', v: 9007199254740992 }]])
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
    XLSX.utils.book_append_sheet(workbook, sheet, 'Riesgos')
    const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as Uint8Array
    const parsed = await parseWorkbook(bytes, { name: 'riesgos.xlsx', size: bytes.length, hasHeader: false })
    const warnings = parsed.workbookWarnings ?? []
    expect(warnings.some((warning) => warning.includes('celdas combinadas'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('precisión segura'))).toBe(true)
    expect(parsed.xlsxCells?.[0][0].precisionWarning).toBe(true)
    expect(parsed.xlsxPrecisionCells).toEqual(['A1'])
    expect(parsed.xlsxPrecisionCount).toBe(1)
  })

  it('validates compressed XLSX entries and measures their actual bounded output', async () => {
    const bytes = compressedFixtureBytes()
    const summary = await validateXlsxZipExpansion(bytes)
    expect(summary.entries).toBeGreaterThan(1)
    expect(summary.uncompressedBytes).toBeGreaterThan(0)
    expect(inspectXlsxZip(bytes).every((entry) => entry.method === 0 || entry.method === 8)).toBe(true)
  })

  it('rejects central/local size mismatches before passing bytes to SheetJS', () => {
    const bytes = compressedFixtureBytes()
    const central = findZipSignature(bytes, 0x02014b50)
    expect(central).toBeGreaterThan(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(central + 24, view.getUint32(central + 24, true) + 1, true)
    expect(() => inspectXlsxZip(bytes)).toThrow(/tamaños o metadatos de encabezados ZIP no coinciden/)
  })

  it('measures actual deflate output instead of trusting matching forged sizes', async () => {
    const bytes = compressedFixtureBytes()
    const central = findZipSignature(bytes, 0x02014b50)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const local = view.getUint32(central + 42, true)
    view.setUint32(central + 24, 1, true)
    view.setUint32(local + 22, 1, true)
    await expect(validateXlsxZipExpansion(bytes)).rejects.toThrow(/salida real de una entrada excede/)
  })

  it('rejects oversized declared entries and totals using small ZIP fixtures only', () => {
    const entryBytes = compressedFixtureBytes()
    const entryCentral = findZipSignature(entryBytes, 0x02014b50)
    new DataView(entryBytes.buffer, entryBytes.byteOffset, entryBytes.byteLength).setUint32(entryCentral + 24, MAX_XLSX_ENTRY_BYTES + 1, true)
    expect(() => inspectXlsxZip(entryBytes)).toThrow(/entrada supera el máximo/)

    expect(() => validateDeclaredXlsxSizes([80, 80], 100, 150)).toThrow(/contenido declarado supera el máximo total/)
    expect(validateDeclaredXlsxSizes([50, 50], 100, 100)).toBe(100)
    expect(MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES).toBe(64 * 1024 * 1024)
  })

  it('rejects data descriptors and corrupted entry checksums', async () => {
    const descriptorBytes = compressedFixtureBytes()
    const central = findZipSignature(descriptorBytes, 0x02014b50)
    const view = new DataView(descriptorBytes.buffer, descriptorBytes.byteOffset, descriptorBytes.byteLength)
    const local = view.getUint32(central + 42, true)
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 8, true)
    view.setUint16(local + 6, view.getUint16(local + 6, true) | 8, true)
    expect(() => inspectXlsxZip(descriptorBytes)).toThrow(/descriptor de datos/)

    const corrupted = fixtureBytes()
    const firstEntry = inspectXlsxZip(corrupted)[0]
    corrupted[firstEntry.dataStart] ^= 0xff
    await expect(validateXlsxZipExpansion(corrupted)).rejects.toThrow(/descomprimirse|CRC/)
  })

  it('rejects ZIP archives with too many entries or a truncated central directory', () => {
    const bytes = compressedFixtureBytes()
    const eocd = findZipSignature(bytes, 0x06054b50)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint16(eocd + 8, MAX_XLSX_ZIP_ENTRIES + 1, true)
    view.setUint16(eocd + 10, MAX_XLSX_ZIP_ENTRIES + 1, true)
    expect(() => inspectXlsxZip(bytes)).toThrow(/número de entradas/)
    expect(() => inspectXlsxZip(bytes.subarray(0, 40))).toThrow(/validación ZIP/)
  })

  it('keeps original cell type and number format after removing a preceding empty row', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['fecha'],
      [''],
      [{ t: 'n', v: 45658, z: 'm/d/yy' }],
    ]), 'Datos')
    const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as Uint8Array
    const document = await parseWorkbook(bytes, { name: 'fechas.xlsx', size: bytes.length })
    const cleaned = applyRules(document, { ...EMPTY_RULES, removeEmpty: true })
    const sourceRowIndexes = document.rows.map((_, index) => index).filter((index) => !cleaned.removedRowIndexes.has(index))
    const output = exportWorkbook(document, cleaned.rows, cleaned.headers, sourceRowIndexes)
    const reopened = XLSX.read(output, { type: 'array', cellNF: true })
    expect(reopened.Sheets.Datos.A2).toMatchObject({ t: 'n', v: 45658, z: 'm/d/yy' })
  })

  it('round-trips transformed data as a single values-only workbook without executing formulas', async () => {
    const document = await parseWorkbook(fixtureBytes(), { name: 'muestra.xlsx', size: 1024 })
    const cleaned = applyRules(document, { ...EMPTY_RULES, trim: true, trimColumns: [3] })
    expect(cleaned.changedCells).toBe(1)
    expect(document.rows[0][3]).toBe(' Muñoz, "Ana"\nNorte ')
    const output = exportWorkbook(document, cleaned.rows, cleaned.headers)
    const reopened = XLSX.read(output, { type: 'array', cellFormula: true, cellNF: true, cellText: true })
    expect(reopened.SheetNames).toEqual(['Datos'])
    const outputSheet = reopened.Sheets.Datos
    expect(outputSheet.B2.v).toBe('000742')
    expect(outputSheet.B2.t).toBe('s')
    expect(outputSheet.C2.z).toBe('m/d/yy')
    expect(outputSheet.D2.v).toBe('Muñoz, "Ana"\nNorte')
    expect(outputSheet.C3.v).toBe(2)
    expect(outputSheet.C3.f).toBeUndefined()
    const roundTrip = await parseWorkbook(output, { name: 'export.xlsx', size: output.byteLength })
    expect(roundTrip.rows).toEqual(cleaned.rows)
  })

  it('fails with a readable error for invalid workbook bytes', async () => {
    await expect(parseWorkbook(new Uint8Array([1, 2, 3, 4]), { name: 'broken.xlsx', size: 4 })).rejects.toThrow(/no parece ser un libro XLSX válido/)
    await expect(parseWorkbook(new Uint8Array(MAX_XLSX_BYTES + 1), { name: 'oversized.xlsx', size: MAX_XLSX_BYTES + 1 })).rejects.toThrow(/límite comprimido actual/)
    await expect(parseWorkbook(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]), { name: 'broken-zip.xlsx', size: 8 })).rejects.toThrow(/validación ZIP/)
  })
})
