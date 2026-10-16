import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ToastHost, showToast } from './Toast.js';

async function mountHost(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<ToastHost />); });
  return renderer;
}

function box(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ 'data-variant': 'error' }).props as { className: string; role: string };
}

describe('ToastHost variants', () => {
  it('renders an error toast with the error icon, red styling and an alert role', async () => {
    const renderer = await mountHost();
    await act(async () => { showToast('Send failed: Upstash HTTP 502', 'error'); });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('✕');
    expect(rendered).not.toContain('✓');
    expect(box(renderer).className).toContain('bg-red-600');
    expect(box(renderer).role).toBe('alert');
    expect(renderer.root.findByProps({ role: 'alert' }).props['aria-live']).toBe('assertive');

    await act(async () => renderer.unmount());
  });

  it('keeps the green check and the status role for messages with no variant', async () => {
    const renderer = await mountHost();
    await act(async () => { showToast('Invite link copied'); });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('✓');
    expect(rendered).not.toContain('✕');
    const success = renderer.root.findByProps({ 'data-variant': 'success' }).props as { role: string; className: string };
    expect(success.role).toBe('status');
    expect(success.className).toContain('bg-ink');
    expect(JSON.stringify(renderer.toJSON())).toContain('bg-emerald-500');

    await act(async () => renderer.unmount());
  });

  it('renders info toasts with a neutral icon and the status role', async () => {
    const renderer = await mountHost();
    await act(async () => { showToast('Attachment is still uploading, please wait', 'info'); });

    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).not.toContain('✓');
    expect(rendered).not.toContain('✕');
    const info = renderer.root.findByProps({ 'data-variant': 'info' }).props as { role: string };
    expect(info.role).toBe('status');
    expect(rendered).toContain('bg-slate-400');

    await act(async () => renderer.unmount());
  });
});
