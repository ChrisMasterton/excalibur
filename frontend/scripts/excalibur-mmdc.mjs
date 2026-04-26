#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const SUPPORTED_RAW_EXTENSIONS = new Set(['.mmd', '.mermaid'])
const SUPPORTED_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

export function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    mode: null,
    inlineSvg: false,
    help: false,
    version: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '-V' || arg === '--version') {
      options.version = true
      continue
    }
    if (arg === '--markdown') {
      options.mode = 'markdown'
      continue
    }
    if (arg === '--raw') {
      options.mode = 'raw'
      continue
    }
    if (arg === '--inline-svg') {
      options.inlineSvg = true
      continue
    }
    if (arg === '-i' || arg === '--input') {
      options.input = readValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith('--input=')) {
      options.input = arg.slice('--input='.length)
      continue
    }
    if (arg === '-o' || arg === '--output') {
      options.output = readValue(argv, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length)
      continue
    }

    throw new CliError(`Unknown argument: ${arg}`, 2)
  }

  if (!options.help && !options.version) {
    if (!options.input) {
      throw new CliError('Missing required input. Use -i <file> or --input <file>.', 2)
    }
    if (!options.output) {
      throw new CliError('Missing required output. Use -o <file> or --output <file>.', 2)
    }
  }

  return options
}

function readValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || (value.startsWith('-') && value !== '-')) {
    throw new CliError(`Missing value for ${flag}.`, 2)
  }
  return value
}

export function getHelpText() {
  return `Usage: excalibur-mmdc -i <input> -o <output> [options]

Options:
  -i, --input <file>    Mermaid, Markdown, or - for stdin
  -o, --output <file>   Output SVG, transformed Markdown file, or - for stdout
      --markdown        Treat input as Markdown
      --raw             Treat input as a single Mermaid diagram
      --inline-svg      Inline rendered SVGs in Markdown output
  -h, --help            Show help
  -V, --version         Show version`
}

function inferMode(inputPath, outputPath, explicitMode) {
  if (explicitMode) {
    return explicitMode
  }

  const inputExtension = inputPath === '-' ? '' : path.extname(inputPath).toLowerCase()
  const outputExtension = path.extname(outputPath).toLowerCase()

  if (SUPPORTED_MARKDOWN_EXTENSIONS.has(inputExtension)) {
    return 'markdown'
  }
  if (SUPPORTED_RAW_EXTENSIONS.has(inputExtension)) {
    return 'raw'
  }
  if (SUPPORTED_MARKDOWN_EXTENSIONS.has(outputExtension)) {
    return 'markdown'
  }

  return 'raw'
}

export function extractMermaidBlocks(markdown) {
  const lines = splitLines(markdown)
  const blocks = []
  let offset = 0
  let openFence = null

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const lineContent = stripLineEnding(line)

    if (!openFence) {
      const match = lineContent.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)
      if (!match) {
        offset += line.length
        continue
      }

      const fence = match[2]
      const info = match[3] ?? ''
      const isMermaid = isMermaidInfoString(info)
      openFence = {
        isMermaid,
        marker: fence[0],
        markerLength: fence.length,
        startLine: lineIndex + 1,
        startOffset: offset,
        contentStartOffset: offset + line.length,
      }
      offset += line.length
      continue
    }

    const closePattern = new RegExp(`^ {0,3}${escapeRegExp(openFence.marker)}{${openFence.markerLength},}\\s*$`)
    if (closePattern.test(lineContent)) {
      if (openFence.isMermaid) {
        blocks.push({
          diagramIndex: blocks.length + 1,
          line: openFence.startLine,
          startOffset: openFence.startOffset,
          endOffset: offset + line.length,
          contentStartOffset: openFence.contentStartOffset,
          contentEndOffset: offset,
          source: markdown.slice(openFence.contentStartOffset, offset),
        })
      }
      openFence = null
    }

    offset += line.length
  }

  if (openFence?.isMermaid) {
    blocks.push({
      diagramIndex: blocks.length + 1,
      line: openFence.startLine,
      startOffset: openFence.startOffset,
      endOffset: markdown.length,
      contentStartOffset: openFence.contentStartOffset,
      contentEndOffset: markdown.length,
      source: markdown.slice(openFence.contentStartOffset),
      unclosed: true,
    })
  }

  return blocks
}

function stripLineEnding(line) {
  return line.replace(/\r\n$|[\r\n]$/, '')
}

function splitLines(text) {
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function isMermaidInfoString(info) {
  const normalized = info.trim().toLowerCase()
  return /^(mermaid\b|\{\.?mermaid[\s}]|\.mermaid\b)/.test(normalized)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function getSvgPathForMarkdown(outputPath, diagramIndex) {
  const parsed = path.parse(outputPath)
  return path.join(parsed.dir, `${parsed.name}-${diagramIndex}.svg`)
}

export function getMarkdownImageReference(outputPath, svgPath, diagramIndex) {
  const relativePath = path.relative(path.dirname(outputPath), svgPath).split(path.sep).join('/')
  return `![Mermaid diagram ${diagramIndex}](${relativePath})`
}

export function replaceMarkdownBlocks(markdown, blocks, replacements) {
  let output = ''
  let cursor = 0

  for (const block of blocks) {
    output += markdown.slice(cursor, block.startOffset)
    output += replacements.get(block.diagramIndex) ?? ''
    cursor = block.endOffset
  }

  output += markdown.slice(cursor)
  return output
}

async function readInput(inputPath) {
  if (inputPath === '-') {
    return readStdin()
  }
  return readFile(inputPath, 'utf8')
}

async function readStdin() {
  process.stdin.setEncoding('utf8')
  let contents = ''

  for await (const chunk of process.stdin) {
    contents += chunk
  }

  return contents
}

async function ensureParentDirectory(filePath) {
  if (filePath === '-') {
    return
  }

  const directory = path.dirname(filePath)
  if (directory && directory !== '.') {
    await mkdir(directory, { recursive: true })
  }
}

function normalizeSvg(svg) {
  return svg.endsWith('\n') ? svg : `${svg}\n`
}

async function createRenderer() {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (error) {
    throw new CliError(
      `Playwright is required for SVG rendering. Run "npm install" in frontend first. ${formatErrorMessage(error)}`,
    )
  }

  const mermaidScript = require.resolve('mermaid/dist/mermaid.min.js')
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new CliError(
      `Unable to launch Chromium for SVG rendering. Run "npm run mmdc:install" in frontend first. ${formatErrorMessage(error)}`,
    )
  }

  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body><div id="container"></div></body></html>')
  await page.addScriptTag({ path: mermaidScript })
  await page.evaluate(() => {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
    })
  })

  return {
    async render(source, diagramIndex) {
      return page.evaluate(
        async ({ diagramSource, id }) => {
          try {
            await window.mermaid.parse(diagramSource)
          } catch (error) {
            return {
              ok: false,
              stage: 'parse',
              message: error instanceof Error ? error.message : String(error),
            }
          }

          try {
            const { svg } = await window.mermaid.render(id, diagramSource)
            return { ok: true, svg }
          } catch (error) {
            return {
              ok: false,
              stage: 'render',
              message: error instanceof Error ? error.message : String(error),
            }
          }
        },
        {
          diagramSource: source.replace(/^\uFEFF/, '').trim(),
          id: `excalibur-mmdc-${Date.now()}-${diagramIndex}`,
        },
      )
    },
    async close() {
      await browser.close()
    },
  }
}

function makeDiagnostic({ inputPath, diagramIndex, line, stage, message }) {
  return {
    file: inputPath,
    diagramIndex,
    line,
    stage,
    message,
  }
}

function writeDiagnostics(diagnostics) {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
  }
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function renderRaw({ inputPath, outputPath, source }) {
  const renderer = await createRenderer()
  try {
    const result = await renderer.render(source, 1)
    if (!result.ok) {
      return {
        ok: false,
        diagnostics: [
          makeDiagnostic({
            inputPath,
            diagramIndex: 1,
            line: 1,
            stage: result.stage,
            message: result.message,
          }),
        ],
      }
    }

    await ensureParentDirectory(outputPath)
    if (outputPath === '-') {
      process.stdout.write(normalizeSvg(result.svg))
    } else {
      await writeFile(outputPath, normalizeSvg(result.svg), 'utf8')
    }
    return { ok: true, diagnostics: [] }
  } finally {
    await renderer.close()
  }
}

async function renderMarkdown({ inputPath, outputPath, source, inlineSvg }) {
  const shouldInlineSvg = inlineSvg || outputPath === '-'
  const blocks = extractMermaidBlocks(source)
  const structuralDiagnostics = blocks
    .filter((block) => block.unclosed)
    .map((block) =>
      makeDiagnostic({
        inputPath,
        diagramIndex: block.diagramIndex,
        line: block.line,
        stage: 'markdown',
        message: 'Unclosed Mermaid code fence.',
      }),
    )

  if (structuralDiagnostics.length > 0) {
    return { ok: false, diagnostics: structuralDiagnostics }
  }

  if (blocks.length === 0) {
    if (outputPath === '-') {
      process.stdout.write(source)
    } else {
      await ensureParentDirectory(outputPath)
      await writeFile(outputPath, source, 'utf8')
    }
    return { ok: true, diagnostics: [] }
  }

  const renderer = await createRenderer()
  const diagnostics = []
  const replacements = new Map()
  const renderedSvgs = []

  try {
    for (const block of blocks) {
      const result = await renderer.render(block.source, block.diagramIndex)
      if (!result.ok) {
        diagnostics.push(
          makeDiagnostic({
            inputPath,
            diagramIndex: block.diagramIndex,
            line: block.line,
            stage: result.stage,
            message: result.message,
          }),
        )
        continue
      }

      if (shouldInlineSvg) {
        replacements.set(block.diagramIndex, normalizeSvg(result.svg))
      } else {
        const svgPath = getSvgPathForMarkdown(outputPath, block.diagramIndex)
        renderedSvgs.push({ path: svgPath, svg: normalizeSvg(result.svg) })
        replacements.set(
          block.diagramIndex,
          `${getMarkdownImageReference(outputPath, svgPath, block.diagramIndex)}\n`,
        )
      }
    }
  } finally {
    await renderer.close()
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics }
  }

  const transformedMarkdown = replaceMarkdownBlocks(source, blocks, replacements)
  if (outputPath === '-') {
    process.stdout.write(transformedMarkdown)
  } else {
    await ensureParentDirectory(outputPath)
    await writeFile(outputPath, transformedMarkdown, 'utf8')
  }

  for (const renderedSvg of renderedSvgs) {
    await ensureParentDirectory(renderedSvg.path)
    await writeFile(renderedSvg.path, renderedSvg.svg, 'utf8')
  }

  return { ok: true, diagnostics: [] }
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)

  if (options.help) {
    process.stdout.write(`${getHelpText()}\n`)
    return 0
  }

  if (options.version) {
    const packageJson = require('../package.json')
    process.stdout.write(`${packageJson.version}\n`)
    return 0
  }

  const inputPath = options.input
  const outputPath = options.output
  const mode = inferMode(inputPath, outputPath, options.mode)
  const source = await readInput(inputPath)
  const result =
    mode === 'markdown'
      ? await renderMarkdown({ inputPath, outputPath, source, inlineSvg: options.inlineSvg })
      : await renderRaw({ inputPath, outputPath, source })

  if (!result.ok) {
    writeDiagnostics(result.diagnostics)
    return 1
  }

  return 0
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''

if (import.meta.url === invokedUrl) {
  try {
    const exitCode = await run()
    process.exitCode = exitCode
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1
    process.stderr.write(`${formatErrorMessage(error)}\n`)
    process.exitCode = exitCode
  }
}
