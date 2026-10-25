import Papa from 'papaparse'

export const DELIMITERS = [',', ';', '\t', '|'] as const
export type Delimiter = (typeof DELIMITERS)[number]

export type CsvRow = string[]
export interface XlsxCellMeta {
  type: string
  value?: string | number | boolean
  formatted?: string
  formula?: string
  numberFormat?: string
  precisionWarning?: boolean
}
export interface SheetSummary {
  name: string
  rows: number
  columns: number
}
export interface CsvDocument {
  name: string
  size: number
  delimiter: Delimiter
  hasHeader: boolean
  originalHeaders: string[]
  rows: CsvRow[]
  expectedWidth: number
  parseErrors: string[]
  encodingWarning: boolean
  format?: 'csv' | 'xlsx'
  sheetName?: string
  sheets?: SheetSummary[]
  xlsxCells?: XlsxCellMeta[][]
  xlsxPrecisionCells?: string[]
  xlsxPrecisionCount?: number
  workbookWarnings?: string[]
}

export interface DelimiterGuess {
  delimiter: Delimiter
  ambiguous: boolean
  widths: number[]
}

export function guessDelimiter(text: string): DelimiterGuess {
  const sample = text.replace(/^\uFEFF/, '').slice(0, 64 * 1024)
  const candidates = DELIMITERS.map((delimiter) => {
    const result = Papa.parse<string[]>(sample, {
      delimiter,
      skipEmptyLines: false,
      preview: 24,
    })
    const widths = result.data.filter((row) => row.some((cell) => cell.length > 0)).map((row) => row.length)
    const counts = new Map<number, number>()
    for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1)
    const modal = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1
    const consistent = widths.length ? (counts.get(modal) ?? 0) / widths.length : 0
    const score = modal > 1 ? (modal - 1) * consistent : 0
    return { delimiter, widths, score, modal, consistent }
  }).sort((a, b) => b.score - a.score)

  const first = candidates[0]
  const second = candidates[1]
  const ambiguous = first.score === 0 || first.consistent < 0.8 || first.score - second.score < Math.max(0.25, first.score * 0.2)
  return { delimiter: first.delimiter, ambiguous, widths: first.widths }
}

export function parseCsvText(
  text: string,
  options: { name: string; size: number; delimiter: Delimiter; hasHeader: boolean },
): CsvDocument {
  if (!text.trim()) throw new Error('El archivo está vacío o solo contiene espacios y saltos de línea.')
  const withoutBom = text.replace(/^\uFEFF/, '')
  const result = Papa.parse<string[]>(withoutBom, {
    delimiter: options.delimiter,
    skipEmptyLines: false,
    dynamicTyping: false,
  })
  const rows = result.data.filter((row, index, all) => !(index === all.length - 1 && row.length === 1 && row[0] === '' && withoutBom.endsWith('\n')))
  const headerRow = options.hasHeader && rows.length ? [...rows[0]] : []
  const dataRows = options.hasHeader ? rows.slice(1) : rows
  const expectedWidth = options.hasHeader ? headerRow.length : (dataRows[0]?.length ?? 0)
  return {
    ...options,
    format: 'csv',
    originalHeaders: headerRow,
    rows: dataRows.map((row) => [...row]),
    expectedWidth,
    parseErrors: result.errors.map((error) => `${error.row === undefined ? '' : `Fila ${error.row + 1}: `}${error.message}`),
    encodingWarning: withoutBom.includes('\uFFFD') || /(?:Ã.|Â.|â€|ï»¿)/.test(withoutBom),
  }
}

export function exportCsv(rows: CsvRow[], headers: string[], delimiter: ',' | ';' | '\t'): string {
  const allRows = headers.length ? [headers, ...rows] : rows
  return '\uFEFF' + Papa.unparse(allRows, {
    delimiter,
    newline: '\r\n',
    quotes: false,
    escapeFormulae: false,
  })
}

export async function exportCsvChunks(
  rows: Iterable<CsvRow>,
  headers: string[],
  delimiter: ',' | ';' | '\t',
  options: { safe?: boolean; batchSize?: number; onProgress?: (processed: number) => void } = {},
): Promise<Blob> {
  const parts: BlobPart[] = ['\uFEFF']
  const batch: string[][] = []
  if (headers.length) batch.push(options.safe ? headers.map(neutralizeFormulaValue) : headers)
  const batchSize = options.batchSize ?? 1000
  let firstChunk = true
  let processed = 0
  const flush = () => {
    if (!batch.length) return
    const content = Papa.unparse(batch, { delimiter, newline: '\r\n', quotes: false, escapeFormulae: false })
    if (!firstChunk) parts.push('\r\n')
    parts.push(content)
    firstChunk = false
    batch.length = 0
  }
  for (const row of rows) {
    batch.push(options.safe ? row.map(neutralizeFormulaValue) : row)
    processed++
    if (batch.length >= batchSize) flush()
    if (processed % 10000 === 0) {
      options.onProgress?.(processed)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  if (batch.length) flush()
  return new Blob(parts, { type: 'text/csv;charset=utf-8' })
}

export function isFormulaRisk(value: string): boolean {
  return /^[\t\r\n ]*[=+\-@]/.test(value)
}

export function neutralizeFormulaValue(value: string): string {
  return isFormulaRisk(value) ? `'${value}` : value
}

export function hasParserTerminalRow(rows: CsvRow[], endsWithNewline: boolean): boolean {
  const lastRow = rows[rows.length - 1]
  return endsWithNewline && lastRow?.length === 1 && lastRow[0] === ''
}
