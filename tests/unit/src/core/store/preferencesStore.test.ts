import { beforeEach, describe, expect, it, vi } from "vitest";

type PrefsModule = typeof import("@/core/store/preferencesStore");

interface ApiStub {
  platform: string;
  loadPreferences: ReturnType<typeof vi.fn>;
  savePreferences: ReturnType<typeof vi.fn>;
}

function stubApi(overrides: Partial<ApiStub> = {}): ApiStub {
  const api: ApiStub = {
    platform: "win32",
    loadPreferences: vi.fn(async () => ({})),
    savePreferences: vi.fn(async () => undefined),
    ...overrides,
  };
  vi.stubGlobal("window", { api });
  return api;
}

/** A fresh preferencesStore singleton per test. */
async function freshModule(): Promise<PrefsModule> {
  vi.resetModules();
  return import("@/core/store/preferencesStore");
}

beforeEach(() => {
  stubApi();
});

describe("preferencesStore", () => {
  it("starts with defaults and is not loaded", async () => {
    const { preferencesStore } = await freshModule();
    const p = preferencesStore.get();
    expect(preferencesStore.isLoaded()).toBe(false);
    expect(p.theme).toBe("dark");
    expect(p.historyMemoryBytes).toBe(4 * 1024 ** 3);
    expect(p.bufferMemoryBytes).toBe(8 * 1024 ** 3);
    expect(p.bufferMemoryMaxOut).toBe(false);
    expect(p.colorImportIntent).toBe("perceptual");
    expect(p.colorConvertIntent).toBe("relative-colorimetric");
  });

  it("load merges disk values over defaults and notifies", async () => {
    stubApi({ loadPreferences: vi.fn(async () => ({ theme: "light", unifiedMemory: false })) });
    const { preferencesStore } = await freshModule();
    const fn = vi.fn();
    preferencesStore.subscribe(fn);
    await preferencesStore.load();
    expect(preferencesStore.isLoaded()).toBe(true);
    expect(preferencesStore.get().theme).toBe("light");
    expect(preferencesStore.get().colorUseBpc).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("seeds unifiedMemory from the platform when it was never saved", async () => {
    stubApi({ platform: "darwin" });
    const mac = await freshModule();
    await mac.preferencesStore.load();
    expect(mac.preferencesStore.get().unifiedMemory).toBe(true);

    stubApi({ platform: "win32" });
    const win = await freshModule();
    await win.preferencesStore.load();
    expect(win.preferencesStore.get().unifiedMemory).toBe(false);

    // A saved value wins over the platform guess.
    stubApi({ platform: "darwin", loadPreferences: vi.fn(async () => ({ unifiedMemory: false })) });
    const saved = await freshModule();
    await saved.preferencesStore.load();
    expect(saved.preferencesStore.get().unifiedMemory).toBe(false);
  });

  it("a failing load falls back to defaults (platform-seeded) and still marks loaded", async () => {
    stubApi({
      platform: "darwin",
      loadPreferences: vi.fn(async () => {
        throw new Error("corrupt");
      }),
    });
    const { preferencesStore } = await freshModule();
    await preferencesStore.load();
    expect(preferencesStore.isLoaded()).toBe(true);
    expect(preferencesStore.get().theme).toBe("dark");
    expect(preferencesStore.get().unifiedMemory).toBe(true);
  });

  it("set updates immediately, notifies, persists the whole value, and returns a new snapshot", async () => {
    const api = stubApi();
    const { preferencesStore } = await freshModule();
    const before = preferencesStore.get();
    const fn = vi.fn();
    const off = preferencesStore.subscribe(fn);
    preferencesStore.set({ theme: "auto" });
    expect(preferencesStore.get().theme).toBe("auto");
    expect(preferencesStore.get()).not.toBe(before);
    expect(before.theme).toBe("dark");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(api.savePreferences).toHaveBeenCalledWith(preferencesStore.get());
    off();
    preferencesStore.set({ theme: "light" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a failing save is swallowed (no unhandled rejection) and keeps the in-memory value", async () => {
    stubApi({
      savePreferences: vi.fn(() => Promise.reject(new Error("disk full"))),
    });
    const { preferencesStore } = await freshModule();
    expect(() => preferencesStore.set({ colorUseBpc: false })).not.toThrow();
    await Promise.resolve();
    expect(preferencesStore.get().colorUseBpc).toBe(false);
  });

  it("load clamps corrupt memory limits from disk into the dialog's range", async () => {
    const GB = 1024 ** 3;
    stubApi({ loadPreferences: vi.fn(async () => ({ historyMemoryBytes: 0, bufferMemoryBytes: "x" })) });
    const a = await freshModule();
    await a.preferencesStore.load();
    expect(a.preferencesStore.get().historyMemoryBytes).toBe(0.5 * GB);
    expect(a.preferencesStore.get().bufferMemoryBytes).toBe(8 * GB);

    stubApi({ loadPreferences: vi.fn(async () => ({ historyMemoryBytes: 1e15, bufferMemoryBytes: -4 })) });
    const b = await freshModule();
    await b.preferencesStore.load();
    expect(b.preferencesStore.get().historyMemoryBytes).toBe(64 * GB);
    expect(b.preferencesStore.get().bufferMemoryBytes).toBe(0.5 * GB);
  });

  it("set keeps the current memory limits when given corrupt values", async () => {
    const { preferencesStore } = await freshModule();
    preferencesStore.set({ historyMemoryBytes: 2 * 1024 ** 3, bufferMemoryBytes: 3 * 1024 ** 3 });
    preferencesStore.set({ historyMemoryBytes: NaN, bufferMemoryBytes: 0, theme: "light" });
    expect(preferencesStore.get().historyMemoryBytes).toBe(2 * 1024 ** 3);
    expect(preferencesStore.get().bufferMemoryBytes).toBe(3 * 1024 ** 3);
    expect(preferencesStore.get().theme).toBe("light");
  });

  it("get() identity is stable between changes", async () => {
    const { preferencesStore } = await freshModule();
    expect(preferencesStore.get()).toBe(preferencesStore.get());
  });

  it("applyThemePreference mirrors the theme onto <html data-theme>", async () => {
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal("document", { documentElement: root });
    const { preferencesStore, applyThemePreference } = await freshModule();
    const off = applyThemePreference();
    expect(root.dataset.theme).toBe("dark");
    preferencesStore.set({ theme: "light" });
    expect(root.dataset.theme).toBe("light");
    off();
    preferencesStore.set({ theme: "auto" });
    expect(root.dataset.theme).toBe("light");
  });
});
