import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./bookmarks-and-notes.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function later(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

describe("bookmarking a Lesson", () => {
  it("adds a Bookmark, and toggling again removes it", () => {
    const student = base.user.id;

    expect(toggleBookmark(db, student, lessonIds[0], NOW)).toBe(true);
    expect(isBookmarked(db, student, lessonIds[0])).toBe(true);

    expect(toggleBookmark(db, student, lessonIds[0], later(1))).toBe(false);
    expect(isBookmarked(db, student, lessonIds[0])).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on one Lesson", () => {
    const student = base.user.id;
    toggleBookmark(db, student, lessonIds[0], NOW);

    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: student, lessonId: lessonIds[0] })
        .run()
    ).toThrow();
    expect(listBookmarks(db, student)).toHaveLength(1);
  });
});

describe("saving a Note", () => {
  it("creates the Note, trimmed, on a Lesson that has none", () => {
    const result = saveNote(db, base.user.id, lessonIds[0], "  first  ", NOW);

    expect(result).toMatchObject({ ok: true, note: { body: "first" } });
    expect(getNote(db, base.user.id, lessonIds[0])).toMatchObject({
      body: "first",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and moves the last-edited time on when saved again", () => {
    saveNote(db, base.user.id, lessonIds[0], "first", NOW);
    saveNote(db, base.user.id, lessonIds[0], "second", later(5));

    expect(getNote(db, base.user.id, lessonIds[0])).toMatchObject({
      body: "second",
      createdAt: NOW.toISOString(),
      updatedAt: later(5).toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("accepts a Note of exactly 2,000 characters", () => {
    const result = saveNote(
      db,
      base.user.id,
      lessonIds[0],
      "a".repeat(2000),
      NOW
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a Note over 2,000 characters with a message", () => {
    const result = saveNote(
      db,
      base.user.id,
      lessonIds[0],
      "a".repeat(2001),
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "A note can be at most 2,000 characters.",
    });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });

  it("clears the Note when saved empty", () => {
    saveNote(db, base.user.id, lessonIds[0], "first", NOW);
    saveNote(db, base.user.id, lessonIds[0], "   ", later(1));

    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });
});

describe("the Saved lists", () => {
  it("hold only the Student's own rows, newest first, with Lesson and Course", () => {
    const other = addStudent("Other");
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[1], later(1));
    toggleBookmark(db, other.id, lessonIds[2], later(2));
    saveNote(db, base.user.id, lessonIds[0], "older", NOW);
    saveNote(db, base.user.id, lessonIds[1], "newer", later(1));
    saveNote(db, other.id, lessonIds[2], "not yours", later(2));

    expect(listBookmarks(db, base.user.id)).toMatchObject([
      {
        lessonTitle: "Lesson 2",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      },
      {
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      },
    ]);
    expect(listNotes(db, base.user.id)).toMatchObject([
      { body: "newer", lessonTitle: "Lesson 2", courseTitle: "Test Course" },
      { body: "older", lessonTitle: "Lesson 1", courseTitle: "Test Course" },
    ]);
  });

  it("order Notes by last edit, not creation", () => {
    saveNote(db, base.user.id, lessonIds[0], "first", NOW);
    saveNote(db, base.user.id, lessonIds[1], "second", later(1));
    saveNote(db, base.user.id, lessonIds[0], "first, edited", later(2));

    expect(listNotes(db, base.user.id).map((note) => note.body)).toEqual([
      "first, edited",
      "second",
    ]);
  });
});

describe("approving a Refund", () => {
  it("leaves the Student's Bookmarks and Notes in place", async () => {
    const notifications = fakeNotifications();
    const admin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    saveNote(db, base.user.id, lessonIds[0], "keep me", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Not for me.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      NOW,
      notifications
    );

    expect(approved.ok).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("keep me");
  });
});
