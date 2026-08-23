export type MermaidHistoryState = {
  text: string
  past: string[]
  future: string[]
}

export type MermaidHistoryAction =
  | { type: 'set'; text: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; text: string }
  | { type: 'restore'; state: MermaidHistoryState }

export const INITIAL_MERMAID_TEXT =
  'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Refine]'

export function mermaidHistoryReducer(
  state: MermaidHistoryState,
  action: MermaidHistoryAction,
): MermaidHistoryState {
  switch (action.type) {
    case 'set': {
      const past = state.past.length >= 100 ? state.past.slice(1) : state.past
      return { text: action.text, past: [...past, state.text], future: [] }
    }
    case 'undo': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return { text: previous, past: state.past.slice(0, -1), future: [state.text, ...state.future] }
    }
    case 'redo': {
      if (state.future.length === 0) return state
      const next = state.future[0]
      return { text: next, past: [...state.past, state.text], future: state.future.slice(1) }
    }
    case 'reset':
      return { text: action.text, past: [], future: [] }
    case 'restore':
      return action.state
    default:
      return state
  }
}
