import type { ProjectTextLanguageId } from '@debrute/project-core';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { codeMirrorLanguageExtensionForProjectTextLanguage } from './textEditorCodeMirrorLanguages';

export interface CanvasTextHighlightSpan {
  from: number;
  to: number;
  className: string;
}

export const canvasTextSyntaxHighlighter = classHighlighter;

export function canvasTextHighlightSpans(input: {
  value: string;
  language: ProjectTextLanguageId;
  baseOffset?: number | undefined;
}): CanvasTextHighlightSpan[] {
  const languageExtension = codeMirrorLanguageExtensionForProjectTextLanguage(input.language);
  if (Array.isArray(languageExtension) && languageExtension.length === 0) {
    return [];
  }
  const state = EditorState.create({
    doc: input.value,
    extensions: [languageExtension]
  });
  const spans: CanvasTextHighlightSpan[] = [];
  const baseOffset = input.baseOffset ?? 0;
  highlightTree(syntaxTree(state), canvasTextSyntaxHighlighter, (from, to, className) => {
    if (from < to && className.length > 0) {
      spans.push({ from: from + baseOffset, to: to + baseOffset, className });
    }
  });
  return spans;
}
