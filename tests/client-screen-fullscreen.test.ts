import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { RoomContext } from '@livekit/components-react';
import { Room } from 'livekit-client';
import { ScreenWorkspace } from '../frontend/client/media.tsx';
import { StageService } from '../backend/src/domain/stage-service.ts';
import type { Principal } from '../shared/types.ts';

type ButtonProps = { 'aria-label'?: string; title?: string; 'aria-pressed'?: boolean; onClick?: () => void; children?: ReactNode };
function fullscreenButton(node: ReactNode): ReactElement<ButtonProps> | undefined {
  if (Array.isArray(node)) return node.map(fullscreenButton).find(Boolean);
  if (!isValidElement<ButtonProps>(node)) return;
  if (node.props['aria-label'] === 'Fullscreen screens') return node;
  return fullscreenButton(node.props.children);
}

test('the actual screen-workspace fullscreen button enters, exits its own native fullscreen, and preserves another element', async () => {
  const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'browser', isOwner: true, isAdmin: true };
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  const room = new Room();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls: string[] = [];
  const nativeDocument = {
    fullscreenElement: null as Element | null,
    exitFullscreen: async () => { calls.push('exit'); nativeDocument.fullscreenElement = null; },
  };
  const screenElement = {
    requestFullscreen: async () => { calls.push('enter'); nativeDocument.fullscreenElement = screenElement as unknown as Element; },
  } as unknown as HTMLDivElement;
  try {
    let tree: ReturnType<typeof ScreenWorkspace> | undefined;
    function Probe() {
      tree = ScreenWorkspace({ state: service.snapshot(owner), command: command => service.execute(owner, command), connected: false, canShare: false, sharePending: false, onShare: () => {} });
      return null;
    }
    renderToString(createElement(RoomContext.Provider, { value: room }, createElement(Probe)));
    assert.ok(tree);
    tree.props.ref.current = screenElement;
    const button = fullscreenButton(tree);
    assert.ok(button?.props.onClick);
    assert.equal(button.props.title, 'Fullscreen screens');
    assert.equal(button.props['aria-pressed'], false);
    Object.defineProperty(globalThis, 'document', { configurable: true, value: nativeDocument });

    button.props.onClick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(nativeDocument.fullscreenElement, screenElement);
    button.props.onClick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(nativeDocument.fullscreenElement, null, 'A second click must use exitFullscreen rather than requestFullscreen again.');
    assert.deepEqual(calls, ['enter', 'exit']);

    nativeDocument.fullscreenElement = {} as Element;
    button.props.onClick();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['enter', 'exit', 'enter'], 'Fullscreen owned by another element must not be mistaken for this workspace.');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    await room.disconnect();
    service.close();
  }
});
