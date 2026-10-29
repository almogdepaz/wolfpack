import { describe, expect, test } from 'bun:test';
import * as geometry from '../../public/viewport-geometry';

describe('main visual viewport keyboard geometry', () => {
  test('only the main occlusion helper remains', () => {
    expect(Object.keys(geometry)).toEqual(['keyboardOcclusionHeight']);
  });
  for (const [layout, height, offsetTop, expected] of [
    [844, 500, 0, 344], [844, 500, 40, 304], [667, 400, 0, 267],
    [800, 500, 20, 280], [800, 780, 40, 0], [844, 844, 0, 0],
    [844, 500.4, 0, 344], [NaN, 500, 0, 0], [800, NaN, 0, 0], [800, 500, Infinity, 0],
  ]) test(`${layout}/${height} pan ${offsetTop}`, () => {
    expect(geometry.keyboardOcclusionHeight(layout!, { height: height!, offsetTop: offsetTop! })).toBe(expected!);
  });
});
