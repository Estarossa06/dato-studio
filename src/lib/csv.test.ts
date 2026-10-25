import { describe, expect, it } from 'vitest'
import { analyzeDocument, applyRules, countDuplicateRows, EMPTY_RULES, initialRulesForDocument, iterateCleanRows, normalizeHeader, previewRules, searchCleanRows } from './clean'
import { countFormulaRisks, exportCsv, exportCsvChunks, guessDelimiter, hasParserTerminalRow, isFormulaRisk, neutralizeFormulaValue, parseCsvText, type Delimiter } from './csv'

function parse(text: string, delimiter: Delimiter = ',', hasHeader = true) {
  return parseCsvText(text, { name: 'datos.csv', size: new TextEncoder().encode(text).length, delimiter, hasHeader })
}

function referencePreview(document: ReturnType<typeof parse>, rules: Parameters<typeof applyRules>[1], limit: number) {
  const full = applyRules(document, rules)
  const rows: string[][] = []
  const removedRowIndexes = new Set<number>()
  let outputIndex = 0
  for (let sourceIndex = 0; sourceIndex < document.rows.length; sourceIndex++) {
    if (full.removedRowIndexes.has(sourceIndex)) {
      if (sourceIndex < limit) removedRowIndexes.add(sourceIndex)
      continue
    }
    if (sourceIndex < limit) rows.push(full.rows[outputIndex])
    outputIndex++
  }
  return { ...full, rows, removedRowIndexes }
}

describe('CSV import', () => {
  it('builds cleaning rules for large documents without a spread argument overflow', () => {
    const document = parse('id\n1')
    document.rows = Array.from({ length: 120_000 }, () => ['x'])
    expect(initialRulesForDocument(document).trimColumns).toEqual([0])
  })

  it.each([
    ['a,b\n1,2', ',', 2],
    ['a;b\n1;2', ';', 2],
    ['a\tb\n1\t2', '\t', 2],
    ['a|b\n1|2', '|', 2],
  ] as const)('parses delimiter %s', (text, delimiter, columns) => {
    const document = parse(text, delimiter)
    expect(document.expectedWidth).toBe(columns)
    expect(document.rows).toEqual([['1', '2']])
  })

  it('keeps quoted delimiters, escaped quotes, and line breaks inside a field', () => {
    const document = parse('name,note\nAda,"said ""hello, world""\nand left"')
    expect(document.rows).toEqual([['Ada', 'said "hello, world"\nand left']])
    expect(document.parseErrors).toEqual([])
  })

  it('strips a BOM and preserves accented UTF-8 text and leading-zero identifiers', () => {
    const document = parse('\uFEFFid,nombre\n000742,Muñoz')
    expect(document.originalHeaders).toEqual(['id', 'nombre'])
    expect(document.rows[0]).toEqual(['000742', 'Muñoz'])
    expect(document.encodingWarning).toBe(false)
  })

  it('retains empty fields and irregular row lengths', () => {
    const document = parse('a,b,c\n1,,3\n4,5\n')
    expect(document.rows).toEqual([['1', '', '3'], ['4', '5']])
    expect(analyzeDocument(document).emptyCells).toBe(1)
    expect(analyzeDocument(document).irregularRows).toBe(1)
  })

  it('keeps empty and duplicate headers in their original order', () => {
    const document = parse(',x,x\n1,2,3')
    expect(document.originalHeaders).toEqual(['', 'x', 'x'])
    expect(analyzeDocument(document).emptyHeaders).toBe(1)
    expect(analyzeDocument(document).duplicateHeaders).toBe(1)
  })

  it('reports malformed quoting and rejects empty content', () => {
    const malformed = parse('a,b\n1,"broken')
    expect(malformed.parseErrors.length).toBeGreaterThan(0)
    expect(() => parse(' \r\n ')).toThrow(/vacío/)
  })

  it('flags uncertain delimiter guesses for review', () => {
    expect(guessDelimiter('solo\ntexto').ambiguous).toBe(true)
    expect(guessDelimiter('a;b\n1;2').delimiter).toBe(';')
  })

  it('removes only Papa Parse’s synthetic terminal row when a file ends with a newline', () => {
    expect(hasParserTerminalRow([['1', '2'], ['']], true)).toBe(true)
    expect(hasParserTerminalRow([['1', '2'], ['']], false)).toBe(false)
    expect(hasParserTerminalRow([['1', '2'], ['', '']], true)).toBe(false)
  })
})

describe('diagnostics and transformations', () => {
  it('counts cached cell formula risks per document and preserves normalized-header semantics', () => {
    const rows = [['+12', 'dato'], ['normal', '-3']]
    expect(countFormulaRisks(rows)).toBe(2)
    expect(countFormulaRisks([['000742', 'Ana']])).toBe(0)
    const unicodeSpaceHeader = '\u00a0=SUM(A1:A2)'
    expect(isFormulaRisk(unicodeSpaceHeader)).toBe(false)
    expect(isFormulaRisk(normalizeHeader(unicodeSpaceHeader))).toBe(true)
  })

  it('matches a full-result reference for combined rules and global preview counts', () => {
    const document = parse(' nombre , código\nplaceholder,0')
    document.rows = [[' A ', 'x'], [' A ', 'x'], ['A', 'x'], ['', ''] , ['', '']]
    for (let index = 0; index < 35; index++) document.rows.push([` Nombre ${index} `, ` valor${index} `])
    document.rows[30] = [...document.rows[5]]
    document.rows[31] = ['', '']
    const rules = {
      ...EMPTY_RULES,
      trim: true,
      trimColumns: [0, 1],
      caseMode: 'upper' as const,
      caseColumns: [0],
      removeEmpty: true,
      removeDuplicates: true,
      normalizeHeaders: true,
    }

    const preview = previewRules(document, rules, 30)
    const reference = referencePreview(document, rules, 30)
    expect(preview.rows).toEqual(reference.rows)
    expect(preview.removedEmpty).toBe(reference.removedEmpty)
    expect(preview.removedDuplicates).toBe(reference.removedDuplicates)
    expect(preview.changedCells).toBe(reference.changedCells)
    expect(preview.changedHeaders).toBe(reference.changedHeaders)
    expect([...preview.removedRowIndexes]).toEqual([...reference.removedRowIndexes])
    expect(preview.removedEmpty).toBe(3)
    expect(preview.removedDuplicates).toBe(2)
    expect(preview.rows.slice(0, 2)).toEqual([['A', 'x'], ['A', 'x']])
    expect(preview.removedRowIndexes.has(30)).toBe(false)
    expect(preview.removedRowIndexes.has(31)).toBe(false)
  })

  it('previews short documents and does not backfill removed source rows with later rows', () => {
    const shortDocument = parse('name\n Ada \nLuis')
    const shortPreview = previewRules(shortDocument, { ...EMPTY_RULES, trim: true, trimColumns: [0] }, 30)
    expect(shortPreview.rows).toEqual([['Ada'], ['Luis']])
    expect(shortPreview.changedCells).toBe(1)

    const boundaryDocument = parse('name\nplaceholder')
    boundaryDocument.rows = Array.from({ length: 30 }, () => [''])
    boundaryDocument.rows.push(['visible only after the preview window'])
    const boundaryPreview = previewRules(boundaryDocument, { ...EMPTY_RULES, removeEmpty: true }, 30)
    expect(boundaryPreview.rows).toEqual([])
    expect(boundaryPreview.removedEmpty).toBe(30)
    expect(boundaryPreview.removedRowIndexes.size).toBe(30)
  })

  it('counts exact ordered duplicate rows while preserving spaces and empty values', () => {
    expect(countDuplicateRows([
      ['a', 'b'], ['a', 'b'], ['b', 'a'], [' a', 'b'], ['a ', 'b'], ['', 'b'], ['', 'b'],
    ])).toBe(2)
  })

  it('distinguishes delimiters, quotes, and Unicode inside cells', () => {
    expect(countDuplicateRows([
      ['a,b', '"c"', 'Muñoz 🌱'],
      ['a,b', '"c"', 'Muñoz 🌱'],
      ['a', 'b,"c"', 'Muñoz 🌱'],
    ])).toBe(1)
  })

  it('verifies exact rows inside deliberately colliding hash buckets', () => {
    const rows = [['a,b', 'c'], ['a', 'b,c'], ['a,b', 'c'], ['única'], ['a', 'b,c']]
    expect(countDuplicateRows(rows, () => 7)).toBe(2)
  })

  it('switches crowded collision buckets to exact keys without false matches', () => {
    const rows = Array.from({ length: 24 }, (_, index) => ['same-first-cell', `different-${index}`])
    rows.push(['same-first-cell', 'different-4'], ['same-first-cell', 'different-23'], ['same-first-cell', 'new-value'])
    expect(countDuplicateRows(rows, () => 0)).toBe(2)
  })

  it('handles large unique and repeated sets without changing their source values', () => {
    const uniqueRows = Array.from({ length: 2_000 }, (_, index) => [`id-${index}`, `valor-${index}`])
    expect(countDuplicateRows(uniqueRows)).toBe(0)
    const repeatedRows = [...uniqueRows, ...uniqueRows]
    const originalRows = structuredClone(repeatedRows)
    expect(countDuplicateRows(repeatedRows)).toBe(uniqueRows.length)
    expect(repeatedRows).toEqual(originalRows)
  })

  it('reports actionable diagnostic counts by column, including irregular rows', () => {
    const document = parse('name,date,note\n Ada ,2024-01-01,\nBob')
    expect(analyzeDocument(document).byColumn).toEqual([
      { index: 0, emptyCells: 0, edgeSpaces: 1, ambiguousValues: 0 },
      { index: 1, emptyCells: 0, edgeSpaces: 0, ambiguousValues: 1 },
      { index: 2, emptyCells: 1, edgeSpaces: 0, ambiguousValues: 0 },
    ])
  })

  it('counts only exact ordered duplicate rows without changing source data', () => {
    const document = parse('a,b\n1,2\n1,2\n2,1')
    const originalRows = structuredClone(document.rows)
    expect(analyzeDocument(document).duplicateRows).toBe(1)
    expect(document.rows).toEqual(originalRows)
  })

  it('trims selected columns and preserves the original rows', () => {
    const document = parse('a,b\n x , y ')
    const result = applyRules(document, { ...EMPTY_RULES, trim: true, trimColumns: [0] })
    expect(result.rows).toEqual([['x', ' y ']])
    expect(document.rows).toEqual([[' x ', ' y ']])
    expect(result.changedCells).toBe(1)
  })

  it('includes extra fields from irregular rows in the all-columns cleaning choice', () => {
    const document = parse('a\nkept, extra ')
    const rules = { ...EMPTY_RULES, trim: true, trimColumns: [0, 1] }
    expect(applyRules(document, rules).rows).toEqual([['kept', 'extra']])
  })

  it('can undo by re-deriving the unchanged source with earlier rules', () => {
    const document = parse('a\n X ')
    const trimmed = applyRules(document, { ...EMPTY_RULES, trim: true, trimColumns: [0] })
    const undone = applyRules(document, EMPTY_RULES)
    expect(trimmed.rows).toEqual([['X']])
    expect(undone.rows).toEqual([[' X ']])
  })

  it('removes only exact empty rows and subsequent duplicate rows when requested', () => {
    const document = parse('a,b\n1,2\n,\n1,2\n')
    const result = applyRules(document, { ...EMPTY_RULES, removeEmpty: true, removeDuplicates: true })
    expect(result.rows).toEqual([['1', '2']])
    expect(result.removedEmpty).toBe(1)
    expect(result.removedDuplicates).toBe(1)
  })

  it('removes exact duplicates without merging distinct rows that share their first cell', () => {
    const document = parse('id,value\nplaceholder,0')
    document.rows = [['same', 'a,b'], ['same', 'a'], ['same', 'b,c'], ['same', 'a,b'], ['same', 'b,c'], ['same', 'a,b,c']]
    const result = applyRules(document, { ...EMPTY_RULES, removeDuplicates: true })
    expect(result.rows).toEqual([['same', 'a,b'], ['same', 'a'], ['same', 'b,c'], ['same', 'a,b,c']])
    expect([...result.removedRowIndexes]).toEqual([3, 4])
    expect(result.removedDuplicates).toBe(2)
  })

  it('keeps exact duplicate cleaning correct after a crowded hash bucket switches strategy', () => {
    const document = parse('id,value\nplaceholder,0')
    document.rows = Array.from({ length: 12 }, (_, index) => ['same', `value-${index}`])
    document.rows.push(['same', 'value-3'], ['same', 'value-11'], ['same', 'new-value'])
    const removed = [...iterateCleanRows(document, { ...EMPTY_RULES, removeDuplicates: true }, undefined, () => 0)]
      .filter((item) => item.removed === 'duplicate')
      .map((item) => item.rowIndex)
    expect(removed).toEqual([12, 13])
  })

  it('searches rows beyond the preview window without changing their source order', () => {
    const document = parse('id,value\nplaceholder,0')
    document.rows = Array.from({ length: 34 }, (_, index) => [`row-${index + 1}`, index === 33 ? 'Hidden marker' : 'ordinary'])
    const result = searchCleanRows(document, EMPTY_RULES, 'MARKER', null)
    expect(result.totalMatches).toBe(1)
    expect(result.rows.map((row) => row.rowIndex)).toEqual([33])
    expect(result.rows[0].original).toEqual(['row-34', 'Hidden marker'])
  })

  it('searches all columns or one selected column, case-insensitively', () => {
    const document = parse('name,note\nneedle,plain\nother,Needle\nNEEDLE,needle')
    expect(searchCleanRows(document, EMPTY_RULES, 'NEEDLE', null).rows.map((row) => row.rowIndex)).toEqual([0, 1, 2])
    expect(searchCleanRows(document, EMPTY_RULES, 'needle', 0).rows.map((row) => row.rowIndex)).toEqual([0, 2])
    expect(searchCleanRows(document, EMPTY_RULES, 'needle', 1).rows.map((row) => row.rowIndex)).toEqual([1, 2])
    expect(searchCleanRows(document, EMPTY_RULES, 'NEEDLE', null, 0, 30, true).rows.map((row) => row.rowIndex)).toEqual([2])
  })

  it('returns no matches for empty queries, missing columns, and absent values', () => {
    const document = parse('name\nAda')
    expect(searchCleanRows(document, EMPTY_RULES, '', null)).toMatchObject({ rows: [], totalMatches: 0 })
    expect(searchCleanRows(document, EMPTY_RULES, 'Ada', 4)).toMatchObject({ rows: [], totalMatches: 0 })
    expect(searchCleanRows(document, EMPTY_RULES, 'Nobody', null)).toMatchObject({ rows: [], totalMatches: 0 })
  })

  it('searches transformed values and excludes rows removed by active cleaning rules', () => {
    const document = parse('name,note\nplaceholder,0')
    document.rows = [[' Ada ', ' keep '], [' Ada ', ' keep '], ['', ''], ['Bob', 'other']]
    const rules = { ...EMPTY_RULES, trim: true, trimColumns: [0, 1], caseMode: 'upper' as const, caseColumns: [1], removeEmpty: true, removeDuplicates: true }
    const result = searchCleanRows(document, rules, 'KEEP', null)
    expect(result.totalMatches).toBe(1)
    expect(result.rows).toEqual([{ rowIndex: 0, original: [' Ada ', ' keep '], values: ['Ada', 'KEEP'] }])
  })

  it('deduplicates matching search rows exactly even when their hashes collide', () => {
    const document = parse('id,value\nplaceholder,0')
    document.rows = [['hit', 'a'], ['miss', 'x'], ['hit', 'b'], ['hit', 'a'], ['hit', 'b']]
    const result = searchCleanRows(document, { ...EMPTY_RULES, removeDuplicates: true }, 'hit', null, 0, 30, false, () => 1)
    expect(result.totalMatches).toBe(2)
    expect(result.rows.map((row) => row.rowIndex)).toEqual([0, 2])
  })

  it('paginates matches in source order and reports the full count', () => {
    const document = parse('id,value\nplaceholder,0')
    document.rows = Array.from({ length: 65 }, (_, index) => [`row-${index + 1}`, `hit-${index + 1}`])
    const firstPage = searchCleanRows(document, EMPTY_RULES, 'hit', null, 0, 30)
    const secondPage = searchCleanRows(document, EMPTY_RULES, 'hit', null, 30, 30)
    const lastPage = searchCleanRows(document, EMPTY_RULES, 'hit', null, 60, 30)
    expect(firstPage.totalMatches).toBe(65)
    expect(firstPage.rows.map((row) => row.rowIndex)).toEqual(Array.from({ length: 30 }, (_, index) => index))
    expect(secondPage.rows.map((row) => row.rowIndex)).toEqual(Array.from({ length: 30 }, (_, index) => index + 30))
    expect(lastPage.rows.map((row) => row.rowIndex)).toEqual([60, 61, 62, 63, 64])
  })

  it('recalculates from supplied rules and documents without affecting undo or export data', () => {
    const document = parse('name\n alpha \n alpha \nbeta')
    const originalRows = structuredClone(document.rows)
    const exportBefore = exportCsv(applyRules(document, EMPTY_RULES).rows, document.originalHeaders, ',')
    const before = searchCleanRows(document, EMPTY_RULES, 'alpha', null)
    const cleaned = searchCleanRows(document, { ...EMPTY_RULES, trim: true, trimColumns: [0], removeDuplicates: true }, 'alpha', null)
    const otherDocument = parse('name\nnew document')
    const afterOpen = searchCleanRows(otherDocument, EMPTY_RULES, 'alpha', null)
    expect(before.totalMatches).toBe(2)
    expect(cleaned.totalMatches).toBe(1)
    expect(afterOpen.totalMatches).toBe(0)
    expect(applyRules(document, EMPTY_RULES).rows).toEqual(originalRows)
    expect(exportCsv(applyRules(document, EMPTY_RULES).rows, document.originalHeaders, ',')).toBe(exportBefore)
    expect(document.rows).toEqual(originalRows)
  })

  it('keeps duplicate cleaning, undo, and CSV export behavior unchanged', () => {
    const document = parse('id,nombre\n000742,"Muñoz, ""Ana"""\n000742,"Muñoz, ""Ana"""\n000743,García')
    const originalRows = structuredClone(document.rows)
    expect(analyzeDocument(document).duplicateRows).toBe(1)
    const cleaned = applyRules(document, { ...EMPTY_RULES, removeDuplicates: true })
    expect(cleaned.rows).toHaveLength(2)
    expect(applyRules(document, EMPTY_RULES).rows).toEqual(originalRows)
    expect(parse(exportCsv(cleaned.rows, cleaned.headers, ',')).rows).toEqual(cleaned.rows)
    expect(document.rows).toEqual(originalRows)
  })
})

describe('CSV export', () => {
  it('quotes delimiters, quotes, line breaks, and keeps accents with a BOM', () => {
    const output = exportCsv([['1', 'Muñoz, "Ana"\nCentro']], ['id', 'nombre'], ',')
    expect(output.charCodeAt(0)).toBe(0xFEFF)
    expect(output).toContain('"Muñoz, ""Ana""\nCentro"')
    const roundTrip = parse(output, ',', true)
    expect(roundTrip.rows).toEqual([['1', 'Muñoz, "Ana"\nCentro']])
  })

  it('supports semicolon and tab output delimiters', () => {
    expect(exportCsv([['1', '2']], ['a', 'b'], ';')).toContain('a;b')
    expect(exportCsv([['1', '2']], ['a', 'b'], '\t')).toContain('a\tb')
  })

  it('exports in bounded chunks and round-trips quoted fields and safe formula values', async () => {
    function* rows() {
      yield ['000742', 'Muñoz, "Ana"\nCentro']
      yield ['=1+1', 'texto']
    }
    const blob = await exportCsvChunks(rows(), ['id', 'nota'], ',', { batchSize: 1, safe: true })
    const output = await blob.text()
    const parsed = parse(output, ',', true)
    expect(parsed.rows).toEqual([['000742', 'Muñoz, "Ana"\nCentro'], ["'=1+1", 'texto']])
  })

  it.each(['=1+1', '+SUM(A1)', '-cmd', '@name', '  =1'])('flags formula-like value %j', (value) => {
    expect(isFormulaRisk(value)).toBe(true)
  })

  it('does not flag regular text as a formula', () => {
    expect(isFormulaRisk('dato-123')).toBe(false)
    expect(isFormulaRisk('hola')).toBe(false)
  })

  it('neutralizes risky values explicitly while leaving ordinary values intact', () => {
    expect(neutralizeFormulaValue('=1+1')).toBe("'=1+1")
    expect(neutralizeFormulaValue(' hola')).toBe(' hola')
  })
})
