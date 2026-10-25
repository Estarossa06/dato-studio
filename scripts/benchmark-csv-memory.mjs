import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import Papa from 'papaparse'
import ts from 'typescript'

const cleanModule = { exports: {} }
const cleanSource = await readFile(new URL('../src/lib/clean.ts', import.meta.url), 'utf8')
const cleanJavaScript = ts.transpile(cleanSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
runInNewContext(cleanJavaScript, { module: cleanModule, exports: cleanModule.exports })
const { analyzeDocument, previewRules, EMPTY_RULES } = cleanModule.exports

const sizes = process.argv.slice(2).map(Number).filter((size) => Number.isFinite(size) && size > 0)
if (!sizes.length) sizes.push(10, 25, 50)
const directory = await mkdtemp(join(tmpdir(), 'dato-studio-csv-bench-'))

async function writeFixture(path, targetBytes) {
  const output = createWriteStream(path)
  output.write('id,codigo,nombre\r\n')
  let written = Buffer.byteLength('id,codigo,nombre\r\n')
  let index = 0
  let lines = ''
  while (written < targetBytes) {
    const line = `${index},000742,Muñoz registro ${index}\r\n`
    lines += line
    written += Buffer.byteLength(line)
    index++
    if (lines.length >= 1024 * 512) {
      if (!output.write(lines)) await once(output, 'drain')
      lines = ''
    }
  }
  if (lines && !output.write(lines)) await once(output, 'drain')
  output.end()
  await once(output, 'finish')
  return { rows: index, bytes: written }
}

try {
  for (const sizeMb of sizes) {
    if (globalThis.gc) globalThis.gc()
    const path = join(directory, `sample-${sizeMb}mb.csv`)
    const start = performance.now()
    const fixture = await writeFixture(path, sizeMb * 1024 * 1024)
    const text = await readFile(path, 'utf8')
    const parseStart = performance.now()
    const rows = []
    let peakRss = process.memoryUsage().rss
    Papa.parse(text, {
      chunkSize: 1024 * 1024,
      dynamicTyping: false,
      skipEmptyLines: false,
      chunk(result) {
        for (const row of result.data) {
          if (row.length === 3 && row[0] === 'id') continue
          rows.push(row)
        }
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
      },
    })
    if (/[\r\n]$/.test(text) && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '') rows.pop()
    const parsedCount = rows.length
    const parseDoneActual = performance.now()
    let formulaLike = 0
    const analysisStart = performance.now()
    const document = { rows, expectedWidth: 3, originalHeaders: ['id', 'codigo', 'nombre'] }
    const analysis = analyzeDocument(document)
    for (const row of rows) for (const cell of row) if (/^[\t\r\n ]*[=+\-@]/.test(cell)) formulaLike++
    const diagnosticsDone = performance.now()
    const previewStart = performance.now()
    const preview = previewRules(document, { ...EMPTY_RULES, trim: true, trimColumns: [1] }, 30)
    const previewSeconds = (performance.now() - previewStart) / 1000
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    console.log(JSON.stringify({
      targetMB: sizeMb,
      fileMB: +(fixture.bytes / 1024 / 1024).toFixed(2),
      rowsWritten: fixture.rows,
      rowsParsed: parsedCount,
      duplicates: analysis.duplicateRows,
      emptyRows: analysis.emptyRows,
      emptyCells: analysis.emptyCells,
      edgeSpaces: analysis.edgeSpaces,
      ambiguousValues: analysis.ambiguousValues,
      formulaLike,
      previewRows: preview.rows.length,
      previewChangedCells: preview.changedCells,
      fixtureAndReadSeconds: +((parseStart - start) / 1000).toFixed(2),
      parseSeconds: +((parseDoneActual - parseStart) / 1000).toFixed(2),
      diagnosticsSeconds: +((diagnosticsDone - analysisStart) / 1000).toFixed(2),
      previewSeconds: +previewSeconds.toFixed(2),
      peakRssMB: +(peakRss / 1024 / 1024).toFixed(0),
    }))
    rows.length = 0
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
