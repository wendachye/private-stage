export interface MediaParticipantState {
  identity: string;
  isSpeaking: boolean;
  isMicrophoneEnabled: boolean;
}

export function participantMediaState(devices: readonly { identity: string }[], participants: readonly MediaParticipantState[]) {
  const identities = new Set(devices.map(device => device.identity));
  const matching = participants.filter(participant => identities.has(participant.identity));
  return {
    speaking: matching.some(participant => participant.isSpeaking),
    microphoneEnabled: matching.some(participant => participant.isMicrophoneEnabled),
  };
}
