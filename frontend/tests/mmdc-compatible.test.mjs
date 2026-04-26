import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'

import {
  extractMermaidBlocks,
  getMarkdownImageReference,
  getSvgPathForMarkdown,
  parseArgs,
  replaceMarkdownBlocks,
} from '../scripts/excalibur-mmdc.mjs'

test('parseArgs accepts mmdc-style input and output flags', () => {
  assert.deepEqual(parseArgs(['-i', 'flow.mmd', '-o', 'flow.svg']), {
    input: 'flow.mmd',
    output: 'flow.svg',
    mode: null,
    inlineSvg: false,
    help: false,
    version: false,
  })
})

test('parseArgs accepts stdin as input', () => {
  assert.equal(parseArgs(['--input', '-', '--output', 'flow.svg']).input, '-')
})

test('extractMermaidBlocks finds mermaid fences and line numbers', () => {
  const markdown = [
    '# Registration',
    '',
    'Before',
    '',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
    '',
    '```js',
    'console.log("not mermaid")',
    '```',
    '',
    '~~~{.mermaid}',
    'sequenceDiagram',
    '  A->>B: hello',
    '~~~',
    '',
  ].join('\n')

  const blocks = extractMermaidBlocks(markdown)

  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].diagramIndex, 1)
  assert.equal(blocks[0].line, 5)
  assert.equal(blocks[0].source, 'flowchart TD\n  A --> B\n')
  assert.equal(blocks[1].diagramIndex, 2)
  assert.equal(blocks[1].line, 14)
  assert.equal(blocks[1].source, 'sequenceDiagram\n  A->>B: hello\n')
})

test('replaceMarkdownBlocks preserves surrounding markdown', () => {
  const markdown = [
    '# Flow',
    '',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
    '',
    'After',
  ].join('\n')
  const blocks = extractMermaidBlocks(markdown)
  const replacements = new Map([[1, '![Mermaid diagram 1](flow-1.svg)\n']])

  assert.equal(
    replaceMarkdownBlocks(markdown, blocks, replacements),
    ['# Flow', '', '![Mermaid diagram 1](flow-1.svg)', '', 'After'].join('\n'),
  )
})

test('getSvgPathForMarkdown mirrors mmdc markdown sidecar SVG naming', () => {
  const outputPath = path.join('/tmp', 'registration-auth-flow.md')
  const svgPath = getSvgPathForMarkdown(outputPath, 2)

  assert.equal(svgPath, path.join('/tmp', 'registration-auth-flow-2.svg'))
  assert.equal(getMarkdownImageReference(outputPath, svgPath, 2), '![Mermaid diagram 2](registration-auth-flow-2.svg)')
})
