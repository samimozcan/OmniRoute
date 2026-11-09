// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "@/shared/components/CommandPalette";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const STORAGE_KEY = "omniroute:command-palette";
const preferenceName = "Most used first";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

function seed(counts: Record<string, unknown>, mostUsedFirst = true) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, mostUsedFirst, counts }));
}

function saved() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
    mostUsedFirst: boolean;
    counts: Record<string, number>;
  } | null;
}

function labels() {
  return screen
    .getAllByRole("option")
    .map((option) => option.querySelector(".ci-command__label")?.textContent);
}

async function openPalette() {
  const view = render(<CommandPalette isOpen onClose={vi.fn()} />);
  await act(async () => {});
  return { ...view, input: screen.getByRole("combobox") };
}

function selectByMouse(label: string) {
  const option = screen
    .getAllByRole("option")
    .find((row) => row.querySelector(".ci-command__label")?.textContent === label);
  expect(option).toBeDefined();
  fireEvent.click(option!);
}

beforeEach(() => {
  localStorage.clear();
  push.mockReset();
  // Only the existing dashboard settings read is allowed; no real network/provider calls.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }))
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cmd+K opt-in frequency ordering", () => {
  it("defaults off, keeps section groups, and does not collect selections while off", async () => {
    const { input } = await openPalette();
    expect((screen.getByRole("switch", { name: preferenceName }) as HTMLInputElement).checked).toBe(
      false
    );
    expect(labels()[0]).toBe("Home");
    expect(document.querySelector("[data-slot=command-group]")).not.toBeNull();
    fireEvent.change(input, { target: { value: "Providers" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/dashboard/providers");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists enabling, preserves groups without history, and ignores searching/browsing", async () => {
    const { unmount } = await openPalette();
    const original = labels();
    fireEvent.click(screen.getByRole("switch", { name: preferenceName }));
    expect(saved()).toEqual({ version: 1, mostUsedFirst: true, counts: {} });
    expect(labels()).toEqual(original);
    expect(document.querySelector("[data-slot=command-group]")).not.toBeNull();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "providers" } });
    expect((input as HTMLInputElement).value).toBe("providers");
    expect(labels()).toContain("Providers");
    expect(labels()).not.toContain("Home");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.pointerMove(screen.getAllByRole("option")[0]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(saved()?.counts).toEqual({});
    unmount();
    await openPalette();
    expect((screen.getByRole("switch", { name: preferenceName }) as HTMLInputElement).checked).toBe(
      true
    );
  });

  it("counts Enter and mouse activation once each, then promotes the item after reopening", async () => {
    seed({});
    let view = await openPalette();
    fireEvent.change(view.input, { target: { value: "Providers" } });
    fireEvent.keyDown(view.input, { key: "Enter" });
    expect(saved()?.counts).toEqual({ providers: 1 });
    view.unmount();
    view = await openPalette();
    expect(labels()[0]).toBe("Providers");
    selectByMouse("Providers");
    expect(push).toHaveBeenCalledTimes(2);
    expect(saved()?.counts).toEqual({ providers: 2 });
  });

  it("sorts globally by count and keeps the original order for every tie", async () => {
    seed({ "costs-quota-share": 4, providers: 4, "model-catalog": 7 });
    await openPalette();
    expect(labels().slice(0, 5)).toEqual([
      "Models & Combos",
      "Providers",
      "Quota Sharing",
      "Home",
      "Endpoints",
    ]);
  });

  it("ranks exact/prefix matches before frequent weaker matches, and frequency breaks search ties", async () => {
    seed({ "model-catalog": 999, "costs-quota-share": 1, providers: 2, quota: 9 });
    const { input } = await openPalette();
    fireEvent.change(input, { target: { value: "Providers" } });
    expect(labels()[0]).toBe("Providers");
    expect(labels()).toContain("Models & Combos");
    fireEvent.change(input, { target: { value: "provider" } });
    expect(labels().slice(0, 2)).toEqual(["Provider Quota", "Providers"]);
    fireEvent.change(input, { target: { value: "quota" } });
    expect(labels()[0]).toBe("Quota Sharing");
    expect(labels().indexOf("Quota Sharing")).toBeLessThan(labels().indexOf("Provider Quota"));
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("No results");
  });

  it("keeps option IDs bound to the same commands when toggling ordering", async () => {
    seed({ providers: 20 }, false);
    await openPalette();
    const row = screen
      .getAllByRole("option")
      .find((option) => option.querySelector(".ci-command__label")?.textContent === "Providers")!;
    const id = row.id;
    fireEvent.click(screen.getByRole("switch", { name: preferenceName }));
    const first = screen.getAllByRole("option")[0];
    // Switching modes remounts the kit Command so its active option follows the new order.
    const input = screen.getByRole("combobox");
    expect(first.querySelector(".ci-command__label")?.textContent).toBe("Providers");
    expect(first.id).toBe(id);
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/dashboard/providers");
    expect(saved()?.counts.providers).toBe(21);
  });

  it("restores original grouping/order and stops counts when the preference is switched off", async () => {
    seed({ providers: 8 });
    await openPalette();
    fireEvent.click(screen.getByRole("switch", { name: preferenceName }));
    expect(labels()[0]).toBe("Home");
    expect(document.querySelector("[data-slot=command-group]")).not.toBeNull();
    selectByMouse("Providers");
    expect(saved()?.mostUsedFirst).toBe(false);
    expect(saved()?.counts.providers).toBe(8);
  });

  it("does not revive hidden items from usage history", async () => {
    seed({ providers: 999, quota: 5 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ hiddenSidebarItems: ["providers"] })))
    );
    await openPalette();
    expect(labels()).not.toContain("Providers");
    expect(labels()[0]).toBe("Provider Quota");
  });

  it.each(["{broken", JSON.stringify({ version: 1, mostUsedFirst: "true", counts: [] })])(
    "falls back safely for corrupt preferences: %s",
    async (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      await openPalette();
      expect(
        (screen.getByRole("switch", { name: preferenceName }) as HTMLInputElement).checked
      ).toBe(false);
      expect(labels()[0]).toBe("Home");
      selectByMouse("Providers");
      expect(push).toHaveBeenCalledWith("/dashboard/providers");
    }
  );

  it("drops stale/invalid IDs and bounds execution counts without losing valid history", async () => {
    seed({
      home: 1_000_000,
      providers: 3,
      quota: -1,
      "model-catalog": 1.5,
      ...Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`removed-${i}`, i + 1])),
    });
    await openPalette();
    selectByMouse("Home");
    expect(saved()?.counts).toEqual({ home: 1_000_000, providers: 3 });
  });

  it("navigates and supports the in-memory toggle when storage access is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await openPalette();
    fireEvent.click(screen.getByRole("switch", { name: preferenceName }));
    selectByMouse("Providers");
    expect(push).toHaveBeenCalledWith("/dashboard/providers");
  });
});
