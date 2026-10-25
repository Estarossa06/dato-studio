import * as XLSX from 'xlsx'
import type { CsvDocument, SheetSummary, XlsxCellMeta } from './csv'
import { MAX_XLSX_BYTES } from './limits'
import { validateXlsxZipExpansion } from './xlsx-zip-guard'

export const MAX_XLSX_SHEETS = 100
export const MAX_XLSX_CELLS = 500_000

export async function parseWorkbook(
  data: ArrayBuffer | Uint8Array,
  options: { name: string; size: number; sheetName?: string; hasHeader?: boolean; onZipValidated?: (summary: { entries: number; uncompressedBytes: number }) => void },
): Promise<CsvDocument> {
  const inputBytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (inputBytes.byteLength > MAX_XLSX_BYTES) throw new Error(`El libro supera el límite comprimido actual de ${MAX_XLSX_BYTES / (1024 * 1024)} MiB.`)
  if (inputBytes.length < 4 || inputBytes[0] !== 0x50 || inputBytes[1] !== 0x4b || inputBytes[2] !== 0x03 || inputBytes[3] !== 0x04) {
    throw new Error('El archivo no parece ser un libro XLSX válido. Comprueba el formato y que no esté dañado.')
  }
  const zipSummary = await validateXlsxZipExpansion(inputBytes)
  options.onZipValidated?.(zipSummary)
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(inputBytes, { type: 'array', cellFormula: true, cellNF: true, cellText: true, cellDates: false })
  } catch {
    throw new Error('No se pudo abrir el libro. Puede estar dañado, protegido con contraseña o usar un formato no compatible.')
  }
  if (!workbook.SheetNames.length) throw new Error('El libro no contiene hojas que se puedan leer.')
  if (workbook.SheetNames.length > MAX_XLSX_SHEETS) throw new Error(`El libro contiene más de ${MAX_XLSX_SHEETS} hojas y excede el límite de procesamiento.`)
  const sheets: SheetSummary[] = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name]
    const ref = sheet?.['!ref']
    if (!ref) return { name, rows: 0, columns: 0 }
    const range = XLSX.utils.decode_range(ref)
    return { name, rows: range.e.r - range.s.r + 1, columns: range.e.c - range.s.c + 1 }
  })
  const sheetName = options.sheetName && workbook.SheetNames.includes(options.sheetName) ? options.sheetName : workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const ref = sheet?.['!ref']
  const rows: string[][] = []
  const xlsxCells: XlsxCellMeta[][] = []
  const xlsxPrecisionCells: string[] = []
  let xlsxPrecisionCount = 0
  let headers: string[] = []
  let expectedWidth = 0
  if (ref && sheet) {
    const range = XLSX.utils.decode_range(ref)
    expectedWidth = range.e.c - range.s.c + 1
    const cellCount = expectedWidth * (range.e.r - range.s.r + 1)
    if (cellCount > MAX_XLSX_CELLS) throw new Error(`La hoja seleccionada contiene más de ${MAX_XLSX_CELLS.toLocaleString('es')} celdas y supera el límite seguro actual.`)
    const matrix: string[][] = []
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex++) {
      const row: string[] = []
      const metaRow: XlsxCellMeta[] = []
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex++) {
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
        const cell = sheet[address]
        const value = cell?.v
        const formatted = typeof cell?.w === 'string' ? cell.w : undefined
        const precisionWarning = cell?.t === 'n' && typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
        if (precisionWarning) {
          xlsxPrecisionCount++
          if (xlsxPrecisionCells.length < 30) xlsxPrecisionCells.push(address)
        }
        const display = cell?.f
          ? (formatted ?? (value === undefined ? `=${cell.f}` : String(value)))
          : (formatted ?? (value === undefined || value === null ? '' : String(value)))
        row.push(display)
        metaRow.push({
          type: cell?.t ?? 'z',
          ...(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? { value } : {}),
          ...(formatted === undefined ? {} : { formatted }),
          ...(typeof cell?.f === 'string' ? { formula: cell.f } : {}),
          ...(typeof cell?.z === 'string' ? { numberFormat: cell.z } : {}),
          ...(precisionWarning ? { precisionWarning: true } : {}),
        })
      }
      matrix.push(row)
      xlsxCells.push(metaRow)
    }
    if (options.hasHeader ?? true) {
      headers = matrix.shift() ?? []
      xlsxCells.shift()
    }
    rows.push(...matrix)
  }
  return {
    name: options.name,
    size: options.size,
    delimiter: ',',
    hasHeader: options.hasHeader ?? true,
    originalHeaders: headers,
    rows,
    expectedWidth,
    parseErrors: [],
    encodingWarning: false,
    format: 'xlsx',
    sheetName,
    sheets,
    xlsxCells,
    xlsxPrecisionCells,
    xlsxPrecisionCount,
    workbookWarnings: collectWarnings(workbook, sheet, rows, xlsxCells),
  }
}

function collectWarnings(workbook: XLSX.WorkBook, sheet: XLSX.WorkSheet, rows: string[][], cells: XlsxCellMeta[][]): string[] {
  const warnings = new Set<string>(['La exportación recrea una sola hoja tabular. No conserva el libro original ni todos sus estilos, gráficos, tablas dinámicas, vínculos o conexiones.'])
  if (cells.some((row) => row.some((cell) => cell.formula))) warnings.add('Las fórmulas se mostrarán como resultados en caché o texto; no se recalculan y se exportarán como valores estáticos.')
  if (cells.some((row) => row.some((cell) => cell.type === 'e'))) warnings.add('La hoja contiene celdas de error de Excel; comprueba los valores mostrados antes de exportar.')
  if ((sheet['!merges']?.length ?? 0) > 0) warnings.add('La hoja contiene celdas combinadas; se leerá el valor de la celda inicial y la exportación no conservará las combinaciones.')
  if (cells.some((row) => row.some((cell) => cell.precisionWarning))) warnings.add('Algunos números enteros superan el rango de precisión segura de JavaScript; verifica los datos marcados en la vista previa. Si el archivo ya perdió precisión, no se puede recuperar aquí.')
  if (workbook.SheetNames.length > 1) warnings.add('La exportación reconstruye solo la hoja seleccionada; las demás hojas no se incluirán.')
  if (rows.some((row) => row.some((value) => value.startsWith('=')))) warnings.add('Algunos valores comienzan con = y deben revisarse para confirmar que son texto y no fórmulas.')
  return [...warnings]
}

export function exportWorkbook(document: CsvDocument, rows: string[][], headers: string[], sourceRowIndexes = rows.map((_, index) => index)): ArrayBuffer {
  const XLSXRows = headers.length ? [headers, ...rows] : rows
  const worksheet = XLSX.utils.aoa_to_sheet(XLSXRows)
  const cells = document.xlsxCells ?? []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < rows[rowIndex].length; columnIndex++) {
      const address = XLSX.utils.encode_cell({ r: rowIndex + (headers.length ? 1 : 0), c: columnIndex })
      const sourceRowIndex = sourceRowIndexes[rowIndex] ?? rowIndex
      const originalText = document.rows[sourceRowIndex]?.[columnIndex] ?? ''
      const value = rows[rowIndex][columnIndex]
      const meta = cells[sourceRowIndex]?.[columnIndex]
      if (meta && value === originalText && !meta.formula) {
        if (meta.value !== undefined) worksheet[address] = { t: meta.type as XLSX.ExcelDataType, v: meta.value, ...(meta.numberFormat ? { z: meta.numberFormat } : {}) }
        else if (meta.type === 'z') worksheet[address] = { t: 'z' }
      } else if (meta?.formula && value === originalText && meta.value !== undefined) {
        worksheet[address] = { t: typeof meta.value === 'number' ? 'n' : typeof meta.value === 'boolean' ? 'b' : 's', v: meta.value }
      } else if (value !== '') {
        worksheet[address] = { t: 's', v: value }
      }
    }
  }
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, (document.sheetName || 'Datos').slice(0, 31) || 'Datos')
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: false }) as ArrayBuffer
}
