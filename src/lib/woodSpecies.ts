import type { WoodSpeciesKey } from '@/types';

export interface WoodSpeciesData {
  name: string;
  baseHex: string;   // representative surface color
  grainHex: string;  // slightly darker tone for grain lines
}

export const WOOD_SPECIES: Record<WoodSpeciesKey, WoodSpeciesData> = {
  maple:        { name: 'Maple',        baseHex: '#f4e8c8', grainHex: '#e0d0a8' },
  cherry:       { name: 'Cherry',       baseHex: '#9b4520', grainHex: '#7d3418' },
  padauk:       { name: 'Padauk',       baseHex: '#c83810', grainHex: '#a02c0a' },
  purpleheart:  { name: 'Purpleheart',  baseHex: '#6b3585', grainHex: '#52286a' },
  walnut:       { name: 'Walnut',       baseHex: '#5a2e10', grainHex: '#3c1c08' },
  ebony:        { name: 'Ebony',        baseHex: '#18100a', grainHex: '#100808' },
  osage_orange: { name: 'Osage Orange', baseHex: '#c89010', grainHex: '#a07008' },
};

export const WOOD_SPECIES_ORDER: WoodSpeciesKey[] = [
  'maple', 'cherry', 'padauk', 'purpleheart', 'walnut', 'ebony', 'osage_orange',
];

/** White or dark text for legibility against a species swatch. */
export function speciesTextColor(baseHex: string): string {
  const r = parseInt(baseHex.slice(1, 3), 16);
  const g = parseInt(baseHex.slice(3, 5), 16);
  const b = parseInt(baseHex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#1e293b' : '#f8fafc';
}

/** Rough guess at species from a detected SVG fill color. */
export function guessSpecies(hex: string): WoodSpeciesKey {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r + g + b) / 3;
  if (brightness < 30)                                   return 'ebony';
  if (brightness > 200)                                  return 'maple';
  if (b > r * 0.8 && b > g)                             return 'purpleheart';
  if (r > 160 && g < 80  && b < 60)                     return 'padauk';
  if (r > 150 && g > 100 && b < 60)                     return 'osage_orange';
  if (r > 100 && g < r * 0.65 && b < 60)                return 'cherry';
  return 'walnut';
}
