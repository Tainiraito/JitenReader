import type { getParagraphs } from './get-paragraphs';
import type { JitenToken } from '@shared/jiten/types';

export type Fragment = {
  node: Text | CDATASection;
  start: number;
  end: number;
  length: number;
  hasRuby: boolean;
  rubyElement?: Element;
};
export type Paragraph = Fragment[];
export type ApplyTokens = (fragments: Fragment[], tokens: JitenToken[]) => void | Promise<void>;

export type DisplayCategory = 'none' | 'text' | 'ruby' | 'ruby-text' | 'block' | 'inline';
export type RegisterOptions = {
  filter?: (node: Element | Node) => boolean;
  onEmpty?: (node: Element | Node) => void;
  getParagraphsFn?: typeof getParagraphs;
  applyFn?: ApplyTokens;
  collapseWhitespace?: boolean;
  onComplete?: () => void;
};
