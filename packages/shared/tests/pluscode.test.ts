import { describe, expect, it } from 'vitest';
import { decodePlusCode, findPlusCode } from '../src/pluscode.js';

describe('Plus Codes', () => {
  // 8FVC9G8F+6X: lat 30+17+0.35+0.015+0.0005 (+half cell) = 47.3655625; lng 0+8+0.5+0.0225+0.002375 (+half) = 8.5249375
  it('decodes a full code to the centre of its cell (spec example)', () => {
    const p = decodePlusCode('8FVC9G8F+6X');
    expect(p?.lat).toBeCloseTo(47.3655625, 6);
    expect(p?.lng).toBeCloseTo(8.5249375, 6);
  });

  it('completes a short code from a nearby reference point (spec example)', () => {
    const p = decodePlusCode('9G8F+6X', { lat: 47.4, lng: 8.6 });
    expect(p?.lat).toBeCloseTo(47.3655625, 6);
    expect(p?.lng).toBeCloseTo(8.5249375, 6);
  });

  it('needs a reference for short codes and rejects nonsense', () => {
    expect(decodePlusCode('9G8F+6X')).toBeNull();
    expect(decodePlusCode('HELLO+AB', { lat: 36.2, lng: 37.1 })).toBeNull();
    expect(decodePlusCode('9G8+6X', { lat: 36.2, lng: 37.1 })).toBeNull();
  });

  it('finds the code inside a Google share address, with the place name after it', () => {
    expect(findPlusCode('644M+8MW ادونيس، ابن العديم')).toBe('644M+8MW');
    expect(findPlusCode('q=54mw+grh جسر الحج')).toBe('54MW+GRH');
    expect(findPlusCode('36.19,37.11')).toBeNull();
  });

  it('places Aleppo short codes in Aleppo', () => {
    const aleppo = { lat: 36.2, lng: 37.13 };
    const p = decodePlusCode('644M+8MW', aleppo);
    expect(p?.lat).toBeGreaterThan(36.1);
    expect(p?.lat).toBeLessThan(36.3);
    expect(p?.lng).toBeGreaterThan(37.0);
    expect(p?.lng).toBeLessThan(37.25);
  });
});
