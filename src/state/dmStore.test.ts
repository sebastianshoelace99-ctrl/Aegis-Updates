import { beforeEach, describe, expect, it } from "vitest";
import {
  DM_STORAGE_KEY,
  MAX_RECENT_DMS,
  loadRecent,
  saveRecent,
  useDmStore,
} from "./dmStore";

type FakeStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  read: () => string | null;
  lastKey: () => string | null;
};

function fakeStorage(initial: string | null = null): FakeStorage {
  let value = initial;
  let key: string | null = null;

  return {
    getItem: () => value,
    setItem: (nextKey, next) => {
      key = nextKey;
      value = next;
    },
    read: () => value,
    lastKey: () => key,
  };
}

describe("direct message history", () => {
  beforeEach(() => {
    useDmStore.setState({ recent: [] });
  });

  it("keeps only string ids, de-duplicated", () => {
    const storage = fakeStorage(JSON.stringify(["kestrel", "kestrel", 7, "", "mira"]));
    expect(loadRecent(storage)).toEqual(["kestrel", "mira"]);
  });

  it("caps a history written by a longer-lived build", () => {
    const ids = Array.from({ length: MAX_RECENT_DMS + 5 }, (_, index) => `member-${index}`);
    expect(loadRecent(fakeStorage(JSON.stringify(ids)))).toHaveLength(MAX_RECENT_DMS);
  });

  it("treats junk as no history rather than throwing", () => {
    expect(loadRecent(fakeStorage("not json"))).toEqual([]);
    expect(loadRecent(fakeStorage(JSON.stringify({ recent: ["kestrel"] })))).toEqual([]);
    // A locked-down or absent storage area must not stop the app from starting.
    expect(loadRecent(null)).toEqual([]);
  });

  it("writes the list under its own key", () => {
    const storage = fakeStorage();

    expect(saveRecent(storage, ["kestrel", "mira"])).toBe(true);
    expect(storage.lastKey()).toBe(DM_STORAGE_KEY);
    expect(storage.read()).toBe(JSON.stringify(["kestrel", "mira"]));
    expect(saveRecent(null, ["kestrel"])).toBe(false);
  });

  it("moves an opened conversation to the front without duplicating it", () => {
    useDmStore.getState().remember("kestrel");
    useDmStore.getState().remember("mira");
    expect(useDmStore.getState().recent).toEqual(["mira", "kestrel"]);

    useDmStore.getState().remember("kestrel");
    expect(useDmStore.getState().recent).toEqual(["kestrel", "mira"]);
  });

  it("forgets a conversation, and ignores an id it never had", () => {
    useDmStore.setState({ recent: ["kestrel", "mira"] });

    useDmStore.getState().forget("kestrel");
    expect(useDmStore.getState().recent).toEqual(["mira"]);

    useDmStore.getState().forget("ghost");
    expect(useDmStore.getState().recent).toEqual(["mira"]);
  });
});
