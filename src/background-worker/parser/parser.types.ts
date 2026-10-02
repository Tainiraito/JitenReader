import { MessageSender } from '@shared/extension/types';
import { JitenToken } from '@shared/jiten/types';
import { ParsePriority } from '@shared/messages/background/parse.command';

export type Handle = {
  sequenceId: number;
  sender: MessageSender;
  text: string;
  length: number;
  priority?: ParsePriority;
  resolve: (tokens: JitenToken[]) => void;
  reject: (error: Error) => void;
};

export type Batch = {
  strings: string[];
  handles: Handle[];
};
