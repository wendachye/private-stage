import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { RoomMode } from '../../shared/types';

export const SPEAKING_MODE_LABELS: Record<RoomMode, string> = {
  open: 'Everyone can talk',
  stage: 'Stage only',
  qa: 'Moderated Q&A',
};

export function speakingModeDescription(mode: RoomMode): string {
  if (mode === 'open') return 'Everyone, including audience members, can choose when to unmute.';
  if (mode === 'qa') return 'Raise a hand and an admin can bring you on stage to speak.';
  return 'Only people on stage can unmute. An admin can invite members to the stage.';
}

/** The same speaking policy applies while Waiting and Live. */
export function SpeakingModeControl({ value, onChange, disabled = false, label = 'Who can speak' }: {
  value: RoomMode;
  onChange: (mode: RoomMode) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  return <div className="field speaking-mode-field">
    <Label htmlFor={id}>{label}</Label>
    <Select value={value} disabled={disabled} onValueChange={mode => {
      if (mode === 'open' || mode === 'stage' || mode === 'qa') onChange(mode);
    }}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{(['open', 'stage', 'qa'] as const).map(mode => <SelectItem key={mode} value={mode}>{SPEAKING_MODE_LABELS[mode]}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}
