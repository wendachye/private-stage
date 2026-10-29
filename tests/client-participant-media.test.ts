import assert from 'node:assert/strict';
import test from 'node:test';
import { participantMediaState } from '../frontend/client/participant-media-state.ts';

test('another device of the local account can own its microphone and speaking indication', () => {
  const devices = [{ identity: 'local-owner' }, { identity: 'remote-owner' }];
  const peers = [
    { identity: 'local-owner', isSpeaking: false, isMicrophoneEnabled: false },
    { identity: 'remote-owner', isSpeaking: true, isMicrophoneEnabled: true },
  ];
  assert.deepEqual(participantMediaState(devices, peers), { speaking: true, microphoneEnabled: true });
});

test('microphone handoff across matching devices keeps the account state accurate', () => {
  const devices = [{ identity: 'local-owner' }, { identity: 'remote-owner' }];
  assert.deepEqual(participantMediaState(devices, [
    { identity: 'local-owner', isSpeaking: true, isMicrophoneEnabled: true },
    { identity: 'remote-owner', isSpeaking: false, isMicrophoneEnabled: false },
  ]), { speaking: true, microphoneEnabled: true });
});

test('unrelated participants cannot light another account microphone or speaking indicator', () => {
  assert.deepEqual(participantMediaState([{ identity: 'member' }], [
    { identity: 'local-owner', isSpeaking: true, isMicrophoneEnabled: true },
    { identity: 'member', isSpeaking: false, isMicrophoneEnabled: false },
  ]), { speaking: false, microphoneEnabled: false });
});

test('departed account devices have no live media state', () => {
  assert.deepEqual(participantMediaState([{ identity: 'departed' }], [
    { identity: 'local-owner', isSpeaking: true, isMicrophoneEnabled: true },
  ]), { speaking: false, microphoneEnabled: false });
});
