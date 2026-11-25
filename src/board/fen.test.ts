import { describe, expect, it } from "vitest";
import { parsePlacement, sqIndex, sqName, splitUci } from "./fen";

describe("fen", () => {
  it("parses the start position", () => {
    const s = parsePlacement("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(s.length).toBe(64);
    expect(s[0]).toEqual({ color: "b", type: "r" });
    expect(s[60]).toEqual({ color: "w", type: "k" });
    expect(s.filter(Boolean).length).toBe(32);
  });
  it("rejects malformed placement", () => {
    expect(() => parsePlacement("8/8/8")).toThrow();
    expect(() => parsePlacement("9/8/8/8/8/8/8/8")).toThrow();
    expect(() => parsePlacement("rnbqkbnx/8/8/8/8/8/8/8")).toThrow();
  });
  it("maps squares", () => {
    expect(sqIndex("a8")).toBe(0);
    expect(sqIndex("h1")).toBe(63);
    expect(sqIndex("e4")).toBe(36);
    expect(sqName(36)).toBe("e4");
    expect(splitUci("e7e8q")).toEqual({ from: "e7", to: "e8", promo: "q" });
  });
});
