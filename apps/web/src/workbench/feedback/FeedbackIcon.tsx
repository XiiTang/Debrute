import React from 'react';
import spriteUrl from './phosphor-fill.svg?url';
import {
  FEEDBACK_ICON_NAMES,
  UNRESOLVED_FEEDBACK_ICON_NAME
} from './generatedFeedbackIconNames';

const knownIdentifiers = new Set<string>(FEEDBACK_ICON_NAMES);

export function isFeedbackIconIdentifier(value: string): boolean {
  return knownIdentifiers.has(value);
}

export function resolvedFeedbackIconIdentifier(value: string | undefined): string {
  return value && isFeedbackIconIdentifier(value) ? value : UNRESOLVED_FEEDBACK_ICON_NAME;
}

export function FeedbackIcon({
  icon,
  size = 18,
  ...props
}: {
  icon: string | undefined;
  size?: number;
} & Omit<React.SVGAttributes<SVGSVGElement>, 'children'>): React.ReactElement {
  const identifier = resolvedFeedbackIconIdentifier(icon);
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden={props['aria-label'] ? undefined : true}
      focusable="false"
      data-feedback-icon={identifier}
    >
      <use href={`${spriteUrl}#phosphor-fill-${identifier}`} />
    </svg>
  );
}
