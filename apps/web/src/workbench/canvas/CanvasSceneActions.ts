import type { WorkbenchActions } from '../../types';

export type CanvasSceneActions = Pick<WorkbenchActions,
  | 'readProjectTextFile'
  | 'resolveCanvasSources'
  | 'saveCanvasTextPreviewSource'
  | 'readCanvasTextPreviewSources'
  | 'readCanvasVideoPreviewSources'
  | 'saveCanvasVideoPreviewSource'
  | 'ensureTextFileBuffer'
  | 'updateTextFileBuffer'
  | 'saveTextFileBuffer'
  | 'discardTextFileBuffer'
  | 'openTextEditorWindow'
  | 'toggleTextFileWordWrap'
  | 'updateCanvasNodeLayouts'
  | 'updateCanvasVideoPlaybackState'
  | 'updateCanvasTextViewportState'
  | 'setCanvasDirectoryExpanded'
  | 'raiseCanvasSelection'
>;

export type CanvasEditorActions = CanvasSceneActions & Pick<WorkbenchActions, 'openProject'>;
