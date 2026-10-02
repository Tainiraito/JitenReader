import { Canceled } from '../../sequence/canceled';
import type { Paragraph } from '../../batches/types';
import type { ParsePriority } from '@shared/messages/background/parse.command';

type Parse = (
  paragraphs: Paragraph[],
  priority: ParsePriority,
  signal: AbortSignal,
) => Promise<void>;
type Ranked = { paragraph: Paragraph; distance: number; text: string };

// Use actual rendered text rectangles, not DOM presence: Ttsu columns keep many
// off-screen paragraphs in the current chapter's content container.
export class TtsuParseScheduler {
  private root?: HTMLElement;
  private viewport?: HTMLElement;
  private observer?: MutationObserver;
  private frame?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private completed = new WeakSet<Text | CDATASection>();
  private prefetched = new Set<string>();

  constructor(
    private read: (root: HTMLElement) => Paragraph[],
    private parse: Parse,
    private onError: (error: Error) => void,
    private onVisibleComplete?: () => void,
  ) {}

  public start(root: HTMLElement, viewport: HTMLElement): void {
    this.stop();
    this.root = root;
    this.viewport = viewport;
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(root, {
      attributes: true,
      attributeFilter: ['id', 'style', 'class'],
      childList: true,
    });

    if (root !== viewport) {
      this.observer.observe(viewport, { attributes: true, attributeFilter: ['style', 'class'] });
    }

    viewport.addEventListener('scroll', this.schedule, { capture: true, passive: true });
    window.addEventListener('resize', this.schedule);
    document.addEventListener('visibilitychange', this.schedule);
    this.schedule();
  }

  public stop(): void {
    this.controller?.abort();
    this.observer?.disconnect();
    this.viewport?.removeEventListener('scroll', this.schedule, true);
    window.removeEventListener('resize', this.schedule);
    document.removeEventListener('visibilitychange', this.schedule);

    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
    }

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }

    this.frame = undefined;
    this.timer = undefined;
    this.root = undefined;
  }

  private schedule = (): void => {
    this.controller?.abort();

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
    }

    if (!this.root || document.hidden) {
      return;
    }

    // Give Ttsu's chapter HTML/column translation one rendering frame to settle.
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        const controller = new AbortController();

        this.controller = controller;
        void this.run(controller.signal);
      });
    });
  };

  private ranked(): Ranked[] {
    const root = this.root;
    const viewport = this.viewport;

    if (!root?.isConnected || !viewport) {
      return [];
    }

    const clip = viewport.getBoundingClientRect();
    const left = Math.max(0, clip.left);
    const right = Math.min(window.innerWidth, clip.right);
    const top = Math.max(0, clip.top);
    const bottom = Math.min(window.innerHeight, clip.bottom);

    if (left >= right || top >= bottom) {
      return [];
    }

    return this.read(root)
      .flatMap((paragraph) => {
        const text = paragraph.map((fragment) => fragment.node.data).join('');

        if (
          !text.replace(/\u200B/g, '').trim() ||
          paragraph.every((fragment) => this.completed.has(fragment.node))
        ) {
          return [];
        }

        let distance = Infinity;

        for (const fragment of paragraph) {
          const range = document.createRange();

          range.selectNodeContents(fragment.node);

          for (const rect of range.getClientRects()) {
            if (rect.width <= 0 || rect.height <= 0) {
              continue;
            }

            const dx = Math.max(left - rect.right, rect.left - right, 0);
            const dy = Math.max(top - rect.bottom, rect.top - bottom, 0);

            distance = Math.min(distance, Math.hypot(dx, dy));
          }
        }

        return Number.isFinite(distance) ? [{ paragraph, distance, text }] : [];
      })
      .sort((a, b) => a.distance - b.distance);
  }

  private chunk(rows: Ranked[], bytes: number, count: number): Ranked[] {
    const result: Ranked[] = [];
    let length = 0;

    for (const row of rows) {
      const size = new TextEncoder().encode(row.text).length;

      if (result.length && (result.length >= count || length + size > bytes)) {
        break;
      }

      result.push(row);
      length += size;
    }

    return result;
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      let visible = this.ranked().filter((row) => row.distance === 0);
      let applied = false;

      while (visible.length && !signal.aborted) {
        const batch = this.chunk(visible, 3000, 12);

        await this.parse(
          batch.map((row) => row.paragraph),
          'visible',
          signal,
        );

        if (signal.aborted) {
          return;
        }

        batch.forEach((row) =>
          row.paragraph.forEach((fragment) => this.completed.add(fragment.node)),
        );
        applied = true;
        visible = this.ranked().filter((row) => row.distance === 0);
      }

      if (!signal.aborted) {
        if (applied) {
          this.onVisibleComplete?.();
        }

        this.prefetchLater(signal);
      }
    } catch (error) {
      if (!signal.aborted && !(error instanceof Canceled)) {
        this.onError(error as Error);
      }
    }
  }

  private prefetchLater(signal: AbortSignal): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;

      if (signal.aborted || document.hidden) {
        return;
      }

      const rows = this.ranked().filter(
        (row) => row.distance > 0 && !this.prefetched.has(row.text),
      );
      const batch = this.chunk(rows, 600, 3);

      if (!batch.length) {
        return;
      }

      // One small background batch at a time. Foreground navigation cancels the
      // queued work; the backend also dispatches visible batches before prefetch.
      void this.parse(
        batch.map((row) => row.paragraph),
        'background',
        signal,
      )
        .then(() => {
          batch.forEach((row) => this.prefetched.add(row.text));

          while (this.prefetched.size > 2000) {
            const [oldest] = this.prefetched;

            this.prefetched.delete(oldest);
          }

          if (!signal.aborted) {
            this.prefetchLater(signal);
          }
        })
        .catch(() => undefined);
    }, 800);
  }
}
