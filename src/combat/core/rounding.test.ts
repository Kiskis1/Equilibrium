import { describe, expect, it } from "vitest";
import { floorDamage, mulFloor, percentFloor } from "./rounding";

describe("rounding", () => {
  it("matches the existing RS3 floating-point integer guard at every stage", () => {
    expect(floorDamage(100 * 1.15)).toBe(115);
    expect(mulFloor(100, 1.15)).toBe(115);
    expect(floorDamage(114.9)).toBe(114);
    expect(floorDamage(100.00001)).toBe(100);
    expect(floorDamage(99.99999999999999)).toBe(100);
  });
  it("floors each step — a chain is not one collapsed multiply", () => {
    const chained = mulFloor(mulFloor(101, 0.9), 2);
    const collapsed = Math.floor(101 * 0.9 * 2);
    expect(chained).toBe(180);
    expect(collapsed).toBe(181);
    expect(chained).not.toBe(collapsed);
  });

  it("percentFloor floors the product", () => {
    expect(percentFloor(1000, 110)).toBe(1100);
    expect(percentFloor(1001, 110)).toBe(1101);
    expect(percentFloor(999, 33)).toBe(329);
  });
});
