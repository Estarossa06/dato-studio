import type { CsvDocument, CsvRow } from './csv'

export interface CleanRules {
  trim: boolean
  trimColumns: number[]
  caseMode: 'none' | 'upper' | 'lower'
  caseColumns: number[]
  removeEmpty: boolean
  removeDuplicates: boolean
  normalizeHeaders: boolean
}

export const EMPTY_RULES: CleanRules = {
  trim: false,
  trimColumns: [],
  caseMode: 'none',
  caseColumns: [],
  removeEmpty: false,
  removeDuplicates: false,
  normalizeHeaders: false,
}

export interface CleanResult {
  headers: string[]
  rows: CsvRow[]
  removedEmpty: number
  removedDuplicates: number
  changedCells: number
  changedHeaders: number
  removedRowIndexes: Set<number>
}

export function isEmptyRow(row: CsvRow): boolean {
  return row.every((cell) => cell === '')
}

export function analyzeDocument(document: CsvDocument) {
  const widthCounts = new Map<number, number>()
  for (const row of document.rows) widthCounts.set(row.length, (widthCounts.get(row.length) ?? 0) + 1)
  const seen = new Set<string>()
  let duplicateRows = 0
  let emptyCells = 0
  let emptyRows = 0
  let edgeSpaces = 0
  let ambiguousValues = 0
  for (const row of document.rows) {
    if (isEmptyRow(row)) emptyRows++
    const key = JSON.stringify(row)
    if (seen.has(key)) duplicateRows++
    else seen.add(key)
    for (const cell of row) {
      if (cell === '') emptyCells++
      if (cell !== cell.trim()) edgeSpaces++
      if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(cell.trim()) || /^\d+[.,]\d+$/.test(cell.trim())) ambiguousValues++
    }
  }
  const headerCounts = new Map<string, number>()
  for (const header of document.originalHeaders) {
    const normalized = header.trim()
    headerCounts.set(normalized, (headerCounts.get(normalized) ?? 0) + 1)
  }
  return {
    rowCount: document.rows.length,
    columnCount: document.expectedWidth,
    emptyCells,
    emptyRows,
    duplicateRows,
    edgeSpaces,
    emptyHeaders: document.originalHeaders.filter((header) => header === '').length,
    duplicateHeaders: [...headerCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    irregularRows: document.rows.reduce((count, row) => count + (row.length !== document.expectedWidth ? 1 : 0), 0),
    ambiguousValues,
    widthCounts,
  }
}

export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, '_').toLocaleLowerCase()
}

export function applyRules(document: CsvDocument, rules: CleanRules): CleanResult {
  const headers = normalizedHeaders(document, rules)
  const removedRowIndexes = new Set<number>()
  const rows: CsvRow[] = []
  let removedEmpty = 0
  let removedDuplicates = 0
  let changedCells = 0
  for (const item of iterateCleanRows(document, rules)) {
    if (item.removed === 'empty') { removedEmpty++; removedRowIndexes.add(item.rowIndex); continue }
    if (item.removed === 'duplicate') { removedDuplicates++; removedRowIndexes.add(item.rowIndex); continue }
    changedCells += item.changedCells
    rows.push(item.values!)
  }
  return {
    headers,
    rows,
    removedEmpty,
    removedDuplicates,
    changedCells,
    changedHeaders: headers.reduce((count, header, index) => count + (header !== document.originalHeaders[index] ? 1 : 0), 0),
    removedRowIndexes,
  }
}

export function previewRules(document: CsvDocument, rules: CleanRules, limit = 30): CleanResult {
  const headers = normalizedHeaders(document, rules)
  const removedRowIndexes = new Set<number>()
  const rows: CsvRow[] = []
  let removedEmpty = 0
  let removedDuplicates = 0
  let changedCells = 0
  for (const item of iterateCleanRows(document, rules)) {
    if (item.removed === 'empty') { removedEmpty++; if (item.rowIndex < limit) removedRowIndexes.add(item.rowIndex); continue }
    if (item.removed === 'duplicate') { removedDuplicates++; if (item.rowIndex < limit) removedRowIndexes.add(item.rowIndex); continue }
    changedCells += item.changedCells
    if (item.rowIndex < limit) rows.push(item.values!)
  }
  return {
    headers,
    rows,
    removedEmpty,
    removedDuplicates,
    changedCells,
    changedHeaders: headers.reduce((count, header, index) => count + (header !== document.originalHeaders[index] ? 1 : 0), 0),
    removedRowIndexes,
  }
}

function normalizedHeaders(document: CsvDocument, rules: CleanRules) {
  return document.originalHeaders.map((header) => rules.normalizeHeaders ? normalizeHeader(header) : header)
}

export function* iterateCleanRows(document: CsvDocument, rules: CleanRules): Generator<{ rowIndex: number; removed?: 'empty' | 'duplicate'; values?: CsvRow; changedCells: number }> {
  const seen = rules.removeDuplicates ? new Set<string>() : null
  for (let rowIndex = 0; rowIndex < document.rows.length; rowIndex++) {
    const sourceRow = document.rows[rowIndex]
    if (rules.removeEmpty && isEmptyRow(sourceRow)) {
      yield { rowIndex, removed: 'empty', changedCells: 0 }
      continue
    }
    if (seen) {
      const key = JSON.stringify(sourceRow)
      if (seen.has(key)) {
        yield { rowIndex, removed: 'duplicate', changedCells: 0 }
        continue
      }
      seen.add(key)
    }
    let changedCells = 0
    const values = sourceRow.map((source, columnIndex) => {
      let value = source
      if (rules.trim && rules.trimColumns.includes(columnIndex)) value = value.trim()
      if (rules.caseMode !== 'none' && rules.caseColumns.includes(columnIndex)) value = rules.caseMode === 'upper' ? value.toLocaleUpperCase() : value.toLocaleLowerCase()
      if (value !== source) changedCells++
      return value
    })
    yield { rowIndex, values, changedCells }
  }
}

export function initialRulesForDocument(document: CsvDocument): CleanRules {
  let width = document.expectedWidth
  for (const row of document.rows) if (row.length > width) width = row.length
  const columns = Array.from({ length: width }, (_, index) => index)
  return { ...EMPTY_RULES, trimColumns: columns, caseColumns: columns }
}
