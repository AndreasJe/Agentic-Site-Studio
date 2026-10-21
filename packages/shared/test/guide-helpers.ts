import type { Guide } from '../src/guide-validate.ts'

/** The QualiWare guide as far as the golden file knows it. */
export const TEST_GUIDE: Guide = {
  version: 1,
  fonts: ['PT Sans', 'PT Sans Narrow', 'PT Serif', 'PT Mono'],
  dominant: 'PT Sans',
  colors: {
    'dark-green': { hex: '#2b675b', role: 'primary' },
    'ice-blue': { hex: '#d2e9e3', role: 'secondary' },
    'dark-blue': { hex: '#2e4163', role: 'secondary' },
    white: { hex: '#ffffff', role: 'base' },
  },
  derived: [
    { hex: '#e3f1ee', recipe: '62% ice-blue + white', use: 'borders' },
    { hex: '#d3dfdc', recipe: '20% dark-green + white', use: 'hover' },
  ],
  motion: {},
}
