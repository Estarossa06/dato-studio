import { describe, expect, it } from 'vitest'
import { analyzeDocument, applyRules, EMPTY_RULES, initialRulesForDocument } from './clean'
import { exportCsv, exportCsvChunks, guessDelimiter, hasParserTerminalRow, isFormulaRisk, neutralizeFormulaValue, parseCsvText, type Delimiter } from './csv'

function parse(text: string, delimiter: Delimiter = ',', hasHeader = true) {
  return parseCsvText(text, { name: 'datos.csv', size: new TextEncoder().encode(text).length, delimiter, hasHeader })
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
  it('counts only exact ordered duplicate rows without changing source data', () => {
    const document = parse('a,b\n1,2\n1,2\n2,1')
    expect(analyzeDocument(document).duplicateRows).toBe(1)
    expect(document.rows).toEqual([['1', '2'], ['1', '2'], ['2', '1']])
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
