// modules/spell-check/index.ts
//
// Replaces the generated index.ts. Self-contained wrapper around the native
// SpellCheck module — ignores the generated src/ files.

import { requireNativeModule } from 'expo';

const SpellCheck = requireNativeModule('SpellCheck');

export type Misspelling = {
  start: number;
  length: number;
  word: string;
  suggestions: string[];
};

export function check(text: string, language: string = 'en_US'): Misspelling[] {
  if (!text) return [];
  return SpellCheck.check(text, language) as Misspelling[];
}
