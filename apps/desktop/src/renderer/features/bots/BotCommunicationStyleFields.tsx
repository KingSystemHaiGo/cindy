import { MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { SettingsSegmentedControl } from '@/components/settings/SettingsSegmentedControl';
import {
  BOT_STYLE_EMOJI_DENSITIES,
  BOT_STYLE_LIMITS,
  BOT_STYLE_REPLY_LENGTHS,
  BOT_STYLE_TONES,
  normalizeBotStyle,
  type BotCommunicationStyle,
  type BotStyleEmojiDensity,
  type BotStyleReplyLength,
  type BotStyleTone,
} from '../../../shared/botStyle';
import { BotSettingsBlock } from './BotSettingsBlock';
import { useBotTranslation } from './botPronounContext';

const TEXTAREA_CLASS =
  'mt-1.5 w-full resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface)] p-3 text-13 leading-6 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
const INPUT_CLASS =
  'mt-1.5 h-10 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 text-13 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

function StyleRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="min-w-0">
        <p className="text-13 font-medium text-[var(--text-primary)]">{label}</p>
        {hint ? <p className="mt-0.5 text-12 leading-5 text-[var(--text-secondary)]">{hint}</p> : null}
      </div>
      <div className="min-w-0 overflow-x-auto">{children}</div>
    </div>
  );
}

export function BotCommunicationStyleFields({
  value,
  onChange,
}: {
  value: BotCommunicationStyle | undefined;
  onChange: (next: BotCommunicationStyle | undefined, kind: 'text' | 'instant') => void;
}) {
  const { t } = useBotTranslation();
  const style = normalizeBotStyle(value) ?? {};
  const patch = (
    next: BotCommunicationStyle,
    kind: 'text' | 'instant',
  ) => onChange(normalizeBotStyle(next), kind);

  return (
    <BotSettingsBlock
      icon={MessageCircle}
      title={t('bots.profile.style.title')}
      hint={t('bots.profile.style.hint')}
      testId="bot-communication-style"
    >
      <div className="flex flex-col gap-4">
        <StyleRow label={t('bots.profile.style.tone')} hint={t('bots.profile.style.toneHint')}>
          <SettingsSegmentedControl<BotStyleTone>
            aria-label={t('bots.profile.style.tone')}
            value={style.tone ?? null}
            onValueChange={(tone) => patch({ ...style, tone }, 'instant')}
            options={BOT_STYLE_TONES.map((tone) => ({
              value: tone,
              label: t(`bots.profile.style.tones.${tone}`),
            }))}
          />
        </StyleRow>
        {style.tone === 'custom' ? (
          <label className="flex min-w-0 flex-col text-12 text-[var(--text-secondary)]">
            {t('bots.profile.style.customTone')}
            <textarea
              aria-label={t('bots.profile.style.customTone')}
              value={style.customTone ?? ''}
              maxLength={BOT_STYLE_LIMITS.customTone}
              rows={3}
              onChange={(event) => patch({ ...style, customTone: event.target.value }, 'text')}
              className={TEXTAREA_CLASS}
            />
          </label>
        ) : null}

        <label className="flex min-w-0 flex-col text-12 text-[var(--text-secondary)]">
          {t('bots.profile.style.addressUserAs')}
          <input
            aria-label={t('bots.profile.style.addressUserAs')}
            value={style.addressUserAs ?? ''}
            maxLength={BOT_STYLE_LIMITS.addressUserAs}
            onChange={(event) => patch({ ...style, addressUserAs: event.target.value }, 'text')}
            className={INPUT_CLASS}
          />
        </label>
        <label className="flex min-w-0 flex-col text-12 text-[var(--text-secondary)]">
          {t('bots.profile.style.selfName')}
          <input
            aria-label={t('bots.profile.style.selfName')}
            value={style.selfName ?? ''}
            maxLength={BOT_STYLE_LIMITS.selfName}
            onChange={(event) => patch({ ...style, selfName: event.target.value }, 'text')}
            className={INPUT_CLASS}
          />
        </label>

        <StyleRow label={t('bots.profile.style.replyLength')}>
          <SettingsSegmentedControl<BotStyleReplyLength>
            aria-label={t('bots.profile.style.replyLength')}
            value={style.replyLength ?? null}
            onValueChange={(replyLength) => patch({ ...style, replyLength }, 'instant')}
            options={BOT_STYLE_REPLY_LENGTHS.map((item) => ({
              value: item,
              label: t(`bots.profile.style.replyLengths.${item}`),
            }))}
          />
        </StyleRow>
        <StyleRow label={t('bots.profile.style.emojiDensity')}>
          <SettingsSegmentedControl<BotStyleEmojiDensity>
            aria-label={t('bots.profile.style.emojiDensity')}
            value={style.emojiDensity ?? null}
            onValueChange={(emojiDensity) => patch({ ...style, emojiDensity }, 'instant')}
            options={BOT_STYLE_EMOJI_DENSITIES.map((item) => ({
              value: item,
              label: t(`bots.profile.style.emojiDensities.${item}`),
            }))}
          />
        </StyleRow>

        <label className="flex min-w-0 flex-col text-12 text-[var(--text-secondary)]">
          {t('bots.profile.style.bannedPhrases')}
          <textarea
            aria-label={t('bots.profile.style.bannedPhrases')}
            value={style.bannedPhrases ?? ''}
            maxLength={BOT_STYLE_LIMITS.bannedPhrases}
            rows={3}
            onChange={(event) => patch({ ...style, bannedPhrases: event.target.value }, 'text')}
            className={TEXTAREA_CLASS}
          />
        </label>
        <label className="flex min-w-0 flex-col text-12 text-[var(--text-secondary)]">
          {t('bots.profile.style.languageHabits')}
          <textarea
            aria-label={t('bots.profile.style.languageHabits')}
            value={style.languageHabits ?? ''}
            maxLength={BOT_STYLE_LIMITS.languageHabits}
            rows={4}
            onChange={(event) => patch({ ...style, languageHabits: event.target.value }, 'text')}
            className={TEXTAREA_CLASS}
          />
        </label>
      </div>
    </BotSettingsBlock>
  );
}
