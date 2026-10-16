// The notice stands in for the composer, so it is the only thing that can
// explain why there is nothing to type into. The two reasons need different
// endings: a muted seat waits for the host, a missing seat cannot be fixed
// from this screen at all — it needs the join flow, hence the link.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SpeakBlockedNotice } from './SpeakBlockedNotice.js';

vi.mock('../i18n/LocaleProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/LocaleProvider.js')>();
  const { translate } = await import('../i18n/messages.js');
  return {
    ...actual,
    useLocale: () => ({
      locale: 'en' as const,
      setLocale: () => {},
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('en', key, values),
      formatDateTime: (value: number | Date) => new Date(value).toLocaleString('en'),
      formatTime: (value: number | Date) => new Date(value).toLocaleTimeString('en'),
      formatNumber: (value: number) => new Intl.NumberFormat('en').format(value),
    }),
  };
});

function render(reason: 'muted' | 'not_member'): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MemoryRouter>
        <SpeakBlockedNotice reason={reason} host="Robin" code="ABC-DEF-GHJ" />
      </MemoryRouter>,
    );
  });
  return renderer;
}

const textOf = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe('SpeakBlockedNotice', () => {
  it('names the host and offers no link when the host muted the viewer', () => {
    const renderer = render('muted');
    expect(textOf(renderer)).toContain('muted by the host');
    expect(textOf(renderer)).toContain('Robin');
    expect(renderer.root.findAllByType('a')).toHaveLength(0);
  });

  it('says the seat is gone and links to the join flow for a non-member', () => {
    const renderer = render('not_member');
    const rendered = textOf(renderer);
    expect(rendered).toContain("You're not in this room");
    expect(rendered).toContain('Rejoin');
    // The host's name has no place here — nobody muted this viewer.
    expect(rendered).not.toContain('Robin');
    expect(renderer.root.findByType('a').props.href).toBe('/j/ABC-DEF-GHJ');
  });
});
