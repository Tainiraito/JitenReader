import type { JitenRawVocabulary, JitenToken } from './types';

export type StaticVocabulary = Omit<JitenRawVocabulary, 'knownState' | 'studyDeckIds'>;
export type WordReference = { wordId: number; readingIndex: number };
export type VocabularyState = { knownState: number[]; studyDeckIds: number[] };
export type ParagraphContent = { tokens: JitenToken[]; vocabulary: StaticVocabulary[] };
export type ContentStorage = {
  load: (keys: string[]) => Promise<Map<string, ParagraphContent>>;
  save: (entries: Map<string, ParagraphContent>) => Promise<void>;
  clear: () => Promise<void>;
};

export const vocabularyKey = ({ wordId, readingIndex }: WordReference): string =>
  `${wordId}:${readingIndex}`;
