import { describe, expect, it } from 'vitest';
import {
  createBookSorter,
  getBookContextMenuItemIds,
  getDisplayedTimeRemaining,
  moveInUpNextQueue,
  pickFresherUpNextOrder,
  withMissingSortValuesLast,
  withReadingStatus,
} from '@/app/library/utils/libraryUtils';
import { isCurrentlyReadingBook } from '@/utils/book';
import type { Book } from '@/types/book';
import { LibrarySortByType } from '@/types/settings';

const createBook = (overrides: Partial<Book> = {}): Book => ({
  hash: 'h',
  format: 'EPUB',
  title: 'T',
  author: 'A',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const queued = (hash: string, upNextOrder?: number): Book =>
  createBook({ hash, title: hash, readingStatus: 'upnext', upNextOrder });

const queueOrder = (books: Book[], changed: Book[]): string[] => {
  const byHash = new Map(books.map((b) => [b.hash, b]));
  for (const b of changed) byHash.set(b.hash, b);
  return [...byHash.values()]
    .filter((b) => b.readingStatus === 'upnext')
    .sort((a, b) => (a.upNextOrder ?? Infinity) - (b.upNextOrder ?? Infinity))
    .map((b) => b.hash);
};

describe('withReadingStatus and the Up Next queue', () => {
  it('puts a book that becomes Up Next at the end of the queue', () => {
    const out = withReadingStatus(createBook({ readingStatus: 'finished' }), 'upnext');
    expect(out.readingStatus).toBe('upnext');
    expect(out.upNextOrder).toBe(out.readingStatusUpdatedAt);
    expect(out.upNextOrderUpdatedAt).toBe(out.readingStatusUpdatedAt);
    // Any order the queue holds was assigned no later than now.
    expect(out.upNextOrder).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('keeps the queue position when an Up Next book is marked Up Next again', () => {
    const book = queued('a', 3);
    expect(withReadingStatus(book, 'upnext').upNextOrder).toBe(3);
  });

  it('leaves the order alone for other statuses', () => {
    const out = withReadingStatus(queued('a', 3), 'finished');
    expect(out.readingStatus).toBe('finished');
    expect(out.upNextOrder).toBe(3);
  });
});

describe('moveInUpNextQueue', () => {
  const library = [
    queued('a', 10),
    queued('b', 20),
    createBook({ hash: 'x', readingStatus: 'finished', upNextOrder: 5 }),
    queued('c', 30),
  ];

  it('moves a book to the top', () => {
    const changed = moveInUpNextQueue(library, 'c', 'top', 99);
    expect(queueOrder(library, changed)).toEqual(['c', 'a', 'b']);
    expect(changed.every((b) => b.upNextOrderUpdatedAt === 99)).toBe(true);
  });

  it('moves a book up and down by one place', () => {
    expect(queueOrder(library, moveInUpNextQueue(library, 'b', 'up'))).toEqual(['b', 'a', 'c']);
    expect(queueOrder(library, moveInUpNextQueue(library, 'b', 'down'))).toEqual(['a', 'c', 'b']);
  });

  it('returns only the books whose order changed', () => {
    const renumbered = [queued('a', 0), queued('b', 1), queued('c', 2)];
    const changed = moveInUpNextQueue(renumbered, 'c', 'up');
    expect(changed.map((b) => b.hash).sort()).toEqual(['b', 'c']);
  });

  it('does not stamp updatedAt, so reordering is not reading', () => {
    const changed = moveInUpNextQueue(library, 'c', 'top');
    for (const book of changed) expect(book.updatedAt).toBe(2);
  });

  it('is a no-op at the ends of the queue and for books not in it', () => {
    expect(moveInUpNextQueue(library, 'a', 'top')).toEqual([]);
    expect(moveInUpNextQueue(library, 'a', 'up')).toEqual([]);
    expect(moveInUpNextQueue(library, 'c', 'down')).toEqual([]);
    expect(moveInUpNextQueue(library, 'x', 'up')).toEqual([]);
  });

  it('orders queued books without a position after the rest, and can move them', () => {
    const books = [queued('a'), queued('b', 1), queued('c', 2)];
    expect(queueOrder(books, moveInUpNextQueue(books, 'a', 'up'))).toEqual(['b', 'a', 'c']);
  });

  it('ignores deleted books', () => {
    const books = [queued('a', 1), { ...queued('d', 2), deletedAt: 5 }, queued('b', 3)];
    expect(queueOrder(books, moveInUpNextQueue(books, 'b', 'up'))).toEqual(['b', 'a', 'd']);
  });
});

describe('pickFresherUpNextOrder', () => {
  it('keeps the order whose own timestamp is newer (ties to the first argument)', () => {
    const local = { upNextOrder: 1, upNextOrderUpdatedAt: 200 };
    const remote = { upNextOrder: 2, upNextOrderUpdatedAt: 100 };
    expect(pickFresherUpNextOrder(local, remote)).toEqual(local);
    expect(pickFresherUpNextOrder(remote, local)).toEqual(local);
    expect(
      pickFresherUpNextOrder({ ...remote, upNextOrderUpdatedAt: 200 }, local).upNextOrder,
    ).toBe(2);
  });

  it('treats a missing timestamp as oldest', () => {
    const remote = { upNextOrder: 4, upNextOrderUpdatedAt: 5 };
    expect(pickFresherUpNextOrder({}, remote)).toEqual(remote);
  });
});

describe('Up Next sort', () => {
  const books = [
    createBook({ hash: 'none', title: 'A' }),
    queued('second', 2),
    queued('first', 1),
    createBook({ hash: 'stale', title: 'B', readingStatus: 'finished', upNextOrder: 0 }),
    queued('unordered'),
  ];

  const sortBy = (ascending: boolean) =>
    [...books]
      .sort(
        withMissingSortValuesLast<Book>(
          LibrarySortByType.UpNext,
          createBookSorter(LibrarySortByType.UpNext, 'en', LibrarySortByType.Title, ascending),
        ),
      )
      .map((b) => b.hash);

  it('lists the queue in order, then everything else by the secondary sort', () => {
    expect(sortBy(true)).toEqual(['first', 'second', 'none', 'stale', 'unordered']);
  });

  it('keeps the books outside the queue last when descending', () => {
    expect(sortBy(false).slice(0, 2)).toEqual(['second', 'first']);
  });
});

describe('Up Next status', () => {
  it('offers Mark as Up Next for books that are not queued', () => {
    for (const readingStatus of [undefined, 'unread', 'finished', 'abandoned'] as const) {
      const ids = getBookContextMenuItemIds(createBook({ readingStatus }));
      expect(ids).toContain('markUpNext');
      expect(ids).not.toContain('moveUpNextToTop');
    }
  });

  it('offers the reorder actions and Clear Status for a queued book', () => {
    const ids = getBookContextMenuItemIds(queued('a', 1));
    expect(ids).not.toContain('markUpNext');
    expect(ids).toEqual(
      expect.arrayContaining([
        'markFinished',
        'markAbandoned',
        'clearStatus',
        'moveUpNextToTop',
        'moveUpNextUp',
        'moveUpNextDown',
      ]),
    );
  });

  it('is not currently reading and shows no time remaining, like unread', () => {
    const book = queued('a', 1);
    book.progress = [10, 100];
    expect(isCurrentlyReadingBook(book)).toBe(false);
    expect(getDisplayedTimeRemaining(book, 60)).toBeUndefined();
  });
});
