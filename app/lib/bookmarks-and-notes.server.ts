import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";
import { MAX_NOTE_LENGTH } from "~/lib/notes";

// ─── Bookmarks and Notes ───
// What a Student attaches to a Lesson for themselves and nobody else. See
// GLOSSARY.md. Nothing outside the owning Student's Lesson page and Saved page
// may read a Note body — never an Instructor or Platform Admin view.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Callers check content access before calling; these functions don't.

export type Db = BetterSQLite3Database<typeof schema>;

type Note = typeof notes.$inferSelect;

export function isBookmarked(db: Db, userId: number, lessonId: number) {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId)))
    .get();
}

/**
 * Adds the Bookmark if the Lesson has none, removes it if it has one. Returns
 * whether the Lesson is now bookmarked. The unique index on (user, lesson)
 * makes a racing second insert a no-op rather than a duplicate.
 */
export function toggleBookmark(
  db: Db,
  userId: number,
  lessonId: number,
  now: Date
): boolean {
  const inserted = db
    .insert(bookmarks)
    .values({ userId, lessonId, createdAt: now.toISOString() })
    .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.lessonId] })
    .returning({ id: bookmarks.id })
    .get();

  if (inserted) return true;

  db.delete(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId)))
    .run();
  return false;
}

export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

export type SaveNoteResult =
  { ok: true; note: Note | null } | { ok: false; error: string };

/**
 * Stores the Student's one Note on a Lesson, trimmed. Saving again replaces
 * the body and moves `updatedAt` (the "last edited" time) on; `createdAt`
 * stays. An empty body clears the Note. Over MAX_NOTE_LENGTH is refused, not
 * truncated.
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const trimmed = body.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `A note can be at most ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters.`,
    };
  }

  if (trimmed.length === 0) {
    db.delete(notes)
      .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
      .run();
    return { ok: true, note: null };
  }

  const iso = now.toISOString();
  const note = db
    .insert(notes)
    .values({ userId, lessonId, body: trimmed, createdAt: iso, updatedAt: iso })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: trimmed, updatedAt: iso },
    })
    .returning()
    .get();

  return { ok: true, note };
}

// The Lesson and Course columns each Saved row needs to link back and name
// its Course.
const savedLessonColumns = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

/** The Student's Bookmarks, newest first. */
export function listBookmarks(db: Db, userId: number) {
  return db
    .select({
      id: bookmarks.id,
      createdAt: bookmarks.createdAt,
      ...savedLessonColumns,
    })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

/** The Student's Notes, most recently edited first. */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...savedLessonColumns,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
