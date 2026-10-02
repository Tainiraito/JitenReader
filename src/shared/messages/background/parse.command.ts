import { BackgroundCommand } from '../lib/background-command';

export type ParsePriority = 'visible' | 'nearby' | 'background';

export class ParseCommand extends BackgroundCommand<
  [data: [sequenceId: number, text: string][], priority?: ParsePriority]
> {
  public readonly key = 'parse';
}
