import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const accessory = html.split('<div id="kb-accessory">')[1]!.split('</div>')[0]!;
const buttons = [...accessory.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];

describe('main accessory markup contract (real sizing covered by mobile browser tests)', () => {
  test('main key order replaces git and copy with one Control C', () => {
    expect(buttons.map(([, attributes]) => attributes!.match(/data-key="([^"]+)"/)?.[1] ?? 'keyboard'))
      .toEqual(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'C-c', 'keyboard']);
    const controlC = buttons.filter(([, attributes]) => attributes!.includes('data-key="C-c"'));
    expect(controlC).toHaveLength(1);
    expect(controlC[0]![1]).toContain('aria-label="Control C"');
    expect(controlC[0]![2]).toBe('^C');
    expect(accessory).not.toContain('<details');
    expect(accessory).not.toContain('kb-git');
    expect(accessory).not.toContain('kb-copy');
  });

  test('all eight keys retain native button semantics and accessible names', () => {
    expect(buttons).toHaveLength(8);
    for (const [, attributes] of buttons) {
      expect(attributes).toContain('type="button"');
      expect(attributes).toContain('aria-label="');
    }
  });
});
