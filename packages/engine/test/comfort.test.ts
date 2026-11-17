import { describe, expect, it } from 'vitest';
import { comfortCorrection } from '../src';

describe('comfortCorrection', () => {
  it('moves 1.5 degrees on the first complaint', () => {
    expect(comfortCorrection(0, 'tooHot')).toBe(-1.5);
    expect(comfortCorrection(0, 'tooCold')).toBe(1.5);
  });
  it('adds half a degree per repeat, up to 2 in all', () => {
    expect(comfortCorrection(-1.5, 'tooHot')).toBe(-2);
    expect(comfortCorrection(-2, 'tooHot')).toBe(-2);
    expect(comfortCorrection(1.5, 'tooCold')).toBe(2);
  });
  it('steps back one degree when the other way is asked for', () => {
    expect(comfortCorrection(-1.5, 'tooCold')).toBe(-0.5);
    expect(comfortCorrection(-0.5, 'tooCold')).toBe(0.5);
    expect(comfortCorrection(2, 'tooHot')).toBe(1);
  });
});
