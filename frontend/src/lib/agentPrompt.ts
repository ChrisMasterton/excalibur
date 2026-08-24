/**
 * Builds the plain-text prompt a user pastes into a coding agent (Claude Code and
 * friends) so the diagrams it writes land in an Excalibur project folder already
 * named the way the diagrams in there are named.
 *
 * Everything here is pure and deterministic: the same request always produces the
 * same string, byte for byte, so the preview in the dialog is exactly what gets
 * copied.
 */

import { symbolKindHint, type SymbolEntry, type SymbolKind } from './symbols'

export type AgentPromptPreset = 'overview' | 'feature' | 'er' | 'sequence' | 'free'

export type AgentPromptInputs = {
  /** Feature deep-dive subject. */
  feature: string
  /** Sequence flow subject. */
  flow: string
  /** Free text task, used verbatim. */
  freeText: string
}

export const EMPTY_AGENT_PROMPT_INPUTS: AgentPromptInputs = { feature: '', flow: '', freeText: '' }

type PresetDefinition = {
  id: AgentPromptPreset
  label: string
  /** Which input the preset requires, if any. */
  field: keyof AgentPromptInputs | null
  fieldLabel: string
  fieldPlaceholder: string
  /** Multi-line input rather than a single line. */
  multiline: boolean
  missingMessage: string
}

export const AGENT_PROMPT_PRESETS: readonly PresetDefinition[] = [
  {
    id: 'overview',
    label: 'Architectural overview',
    field: null,
    fieldLabel: '',
    fieldPlaceholder: '',
    multiline: false,
    missingMessage: '',
  },
  {
    id: 'feature',
    label: 'Feature deep-dive',
    field: 'feature',
    fieldLabel: 'Feature',
    fieldPlaceholder: 'e.g. Checkout and payment capture',
    multiline: false,
    missingMessage: 'Name the feature to dig into.',
  },
  {
    id: 'er',
    label: 'ER / data model',
    field: null,
    fieldLabel: '',
    fieldPlaceholder: '',
    multiline: false,
    missingMessage: '',
  },
  {
    id: 'sequence',
    label: 'Sequence for a flow',
    field: 'flow',
    fieldLabel: 'Flow',
    fieldPlaceholder: 'e.g. A user signs in with a magic link',
    multiline: false,
    missingMessage: 'Name the flow to trace.',
  },
  {
    id: 'free',
    label: 'Free text',
    field: 'freeText',
    fieldLabel: 'Task',
    fieldPlaceholder: 'Describe what the agent should diagram…',
    multiline: true,
    missingMessage: 'Describe the diagrams you want.',
  },
]

export function agentPromptPreset(id: AgentPromptPreset): PresetDefinition {
  return AGENT_PROMPT_PRESETS.find((preset) => preset.id === id) ?? AGENT_PROMPT_PRESETS[0]
}

export function isAgentPromptPreset(value: string): value is AgentPromptPreset {
  return AGENT_PROMPT_PRESETS.some((preset) => preset.id === value)
}

/** The message to show when the preset's required field is still empty, else null. */
export function agentPromptInputError(
  preset: AgentPromptPreset,
  inputs: AgentPromptInputs,
): string | null {
  const definition = agentPromptPreset(preset)
  if (!definition.field) {
    return null
  }
  return inputs[definition.field].trim() ? null : definition.missingMessage
}

/** One diagram already sitting in the project folder. */
export type AgentPromptFile = {
  relativePath: string
  title?: string | null
}

/** One name the project's diagrams already use, and how widely. */
export type AgentPromptSymbol = {
  display: string
  kind: SymbolKind
  owner?: string
  /** How many documents in the project mention it. */
  documents: number
}

export type AgentPromptRequest = {
  preset: AgentPromptPreset
  inputs: AgentPromptInputs
  project: { name: string; path: string }
  files: readonly AgentPromptFile[]
  symbols: readonly AgentPromptSymbol[]
}

export const AGENT_PROMPT_SYMBOL_LIMIT = 80

/** Sections the vocabulary is grouped into, in the order they are printed. */
const VOCABULARY_GROUPS: ReadonlyArray<{ title: string; kinds: readonly SymbolKind[] }> = [
  { title: 'Classes and entities', kinds: ['class', 'entity'] },
  { title: 'Participants, nodes, and states', kinds: ['participant', 'node', 'state'] },
  { title: 'Members and attributes', kinds: ['member', 'attribute'] },
  { title: 'Other labels', kinds: ['text'] },
]

/** Ties are broken by kind so the structural names sort above stray text labels. */
const KIND_RANK: Record<SymbolKind, number> = {
  class: 0,
  entity: 0,
  participant: 1,
  node: 1,
  state: 1,
  member: 2,
  attribute: 2,
  text: 3,
}

/**
 * The project's vocabulary, busiest name first: every symbol the index found,
 * counted by how many documents mention it. The qualified `Owner.member` copies
 * the index also files are dropped, since the member entry already carries its
 * owner.
 */
export function collectPromptSymbols(
  entries: readonly SymbolEntry[],
  limit = AGENT_PROMPT_SYMBOL_LIMIT,
): AgentPromptSymbol[] {
  const bySymbol = new Map<string, { entry: SymbolEntry; documents: Set<string> }>()

  for (const entry of entries) {
    if (entry.display.includes('.')) {
      continue
    }
    const existing = bySymbol.get(entry.symbol)
    if (existing) {
      existing.documents.add(entry.doc.path)
      // Prefer the spelling used by the more structural kind, then the first alphabetically.
      const better =
        KIND_RANK[entry.kind] < KIND_RANK[existing.entry.kind] ||
        (KIND_RANK[entry.kind] === KIND_RANK[existing.entry.kind] &&
          entry.display.localeCompare(existing.entry.display) < 0)
      if (better) {
        existing.entry = entry
      }
      continue
    }
    bySymbol.set(entry.symbol, { entry, documents: new Set([entry.doc.path]) })
  }

  return [...bySymbol.values()]
    .map(({ entry, documents }) => ({
      display: entry.display,
      kind: entry.kind,
      ...(entry.owner ? { owner: entry.owner } : {}),
      documents: documents.size,
    }))
    .sort(
      (a, b) =>
        b.documents - a.documents ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.display.localeCompare(b.display),
    )
    .slice(0, limit)
}

/** Keeps the preview readable before a required field has been filled in. */
function filled(value: string, placeholder: string) {
  return value.trim() || placeholder
}

function taskSection(preset: AgentPromptPreset, inputs: AgentPromptInputs): string[] {
  switch (preset) {
    case 'feature':
      return [
        `Analyse this codebase and produce Mermaid diagrams explaining the "${filled(inputs.feature, '<feature>')}" feature in depth: the pieces it is built from, how they fit together, and what happens when it runs.`,
        '',
        '- Add a `classDiagram` for the types the feature is built from, with the relationships between them.',
        '- Add a `sequenceDiagram` for its main path end to end, including the failure branches a reader would need.',
        '- Follow the real code before drawing anything; do not diagram what you assume is there.',
      ]
    case 'er':
      return [
        'Analyse this codebase and produce Mermaid `erDiagram` diagrams of its data model: the entities it persists, their keys and attributes, and the relationships between them.',
        '',
        '- Take the entities from the real schema (migrations, models, or DDL), not from guesswork.',
        '- Mark cardinality on every relationship, and mark primary and foreign keys.',
        '- Split a large model across several diagrams rather than crowding one.',
      ]
    case 'sequence':
      return [
        `Analyse this codebase and produce Mermaid \`sequenceDiagram\` diagrams for the "${filled(inputs.flow, '<flow>')}" flow: every participant it touches, in the order it touches them.`,
        '',
        '- Follow the real call path through the code, from the entry point to the result.',
        '- Include the error and retry branches that change what a reader would expect.',
        '- Give a significant alternative path its own diagram rather than crowding one.',
      ]
    case 'free':
      return [filled(inputs.freeText, '<describe the diagrams you want>')]
    case 'overview':
    default:
      return [
        'Analyse this codebase and produce Mermaid diagrams giving an architectural overview of it: what the major components are, what each is responsible for, and how they talk to each other.',
        '',
        '- Start with a `flowchart` of the top-level components and the flow between them.',
        '- Add a `classDiagram` for the core types and their relationships where the code has them.',
        '- Follow the real code before drawing anything; do not diagram what you assume is there.',
      ]
  }
}

function filesSection(files: readonly AgentPromptFile[]): string[] {
  if (!files.length) {
    return ['Existing diagrams: none yet.']
  }
  const lines = ['Existing diagrams in that folder:']
  for (const file of files) {
    const title = file.title?.trim()
    lines.push(title ? `- ${file.relativePath} — ${title}` : `- ${file.relativePath}`)
  }
  return lines
}

function vocabularySection(symbols: readonly AgentPromptSymbol[]): string[] {
  if (!symbols.length) {
    return [
      'Vocabulary: the project has no indexed names yet, so pick names straight from the code and stay consistent across the diagrams you write.',
    ]
  }
  const lines = [
    'Vocabulary already used by those diagrams. Reuse THESE exact names for the same concepts; do not invent synonyms, re-case them, or pluralise them:',
  ]
  for (const group of VOCABULARY_GROUPS) {
    const members = symbols.filter((symbol) => group.kinds.includes(symbol.kind))
    if (!members.length) {
      continue
    }
    lines.push('', `${group.title}:`)
    for (const symbol of members) {
      lines.push(`- ${symbol.display} (${symbolKindHint(symbol.kind, symbol.owner)})`)
    }
  }
  return lines
}

function outputContract(projectPath: string): string[] {
  return [
    '## Output contract',
    '',
    `- Write each diagram as its own file directly into ${projectPath}. No subfolders.`,
    '- Use the `.mmd` extension.',
    '- Write RAW Mermaid only: no Markdown code fences, no prose before or after the diagram, no explanation in the file.',
    '- Start every file with YAML frontmatter carrying a human-readable `title:`, exactly like this:',
    '',
    '    ---',
    '    title: Checkout and payment capture',
    '    ---',
    '    sequenceDiagram',
    '',
    '- Name files in kebab-case after the title, e.g. `checkout-and-payment-capture.mmd`.',
    '- Prefer one diagram per concern; several readable diagrams beat one crowded one.',
    '- Avoid `<br/>` in labels. Keep labels short instead.',
    '- Node, class, entity, and participant identifiers must be plain identifiers and must match the vocabulary above wherever the concept already exists there.',
    '- Do not overwrite an existing file unless you are updating that exact diagram.',
    '',
    'That folder is watched by Excalibur, so a file you write there is immediately openable in the app.',
  ]
}

/** The whole prompt, ready to paste into a coding agent. */
export function buildAgentPrompt(request: AgentPromptRequest): string {
  const { preset, inputs, project, files, symbols } = request
  const lines = [
    '## Task',
    '',
    ...taskSection(preset, inputs),
    '',
    '## Project context',
    '',
    `Write the diagrams into the Excalibur project "${project.name}".`,
    `Project folder: ${project.path}`,
    '',
    ...filesSection(files),
    '',
    ...vocabularySection(symbols),
    '',
    ...outputContract(project.path),
  ]
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
