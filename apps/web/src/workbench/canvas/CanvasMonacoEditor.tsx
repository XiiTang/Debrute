import React from 'react';
import Editor from '@monaco-editor/react';
import { monacoLanguageForProjectTextLanguage } from './textEditorLanguages';

export function CanvasMonacoEditor({
  value,
  language,
  wordWrap,
  readOnly,
  onChange,
  onSave,
  onToggleWordWrap
}: {
  value: string;
  language: string;
  wordWrap: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onToggleWordWrap: () => void;
}): React.ReactElement {
  const keyboardShortcuts = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
      return;
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && (event.code === 'KeyZ' || event.key.toLowerCase() === 'z')) {
      event.preventDefault();
      onToggleWordWrap();
    }
  };
  const wordWrapState = wordWrap ? 'on' : 'off';

  return (
    <div
      data-canvas-text-editor="true"
      data-editor-engine="monaco"
      data-word-wrap={wordWrapState}
      className="canvas-monaco-editor"
      onKeyDown={keyboardShortcuts}
    >
      <Editor
        value={value}
        language={monacoLanguageForProjectTextLanguage(language)}
        theme="vs-dark"
        options={{
          readOnly: readOnly === true,
          minimap: { enabled: false },
          wordWrap: wordWrap ? 'on' : 'off',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          fontSize: 12,
          lineNumbersMinChars: 3,
          overviewRulerLanes: 0,
          scrollbar: {
            alwaysConsumeMouseWheel: false
          }
        }}
        onChange={(next) => onChange(next ?? '')}
        onMount={(editor, monaco) => {
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
          editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, onToggleWordWrap);
        }}
      />
    </div>
  );
}
