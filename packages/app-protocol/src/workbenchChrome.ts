export type NativeMenuCommand =
  | {
      commandId:
        | 'window.new'
        | 'project.open-picker'
        | 'window.close'
        | 'edit.undo'
        | 'edit.redo'
        | 'edit.cut'
        | 'edit.copy'
        | 'edit.paste'
        | 'edit.paste-and-match-style'
        | 'edit.delete'
        | 'edit.select-all'
        | 'view.reload'
        | 'view.toggle-devtools';
    }
  | {
      commandId: 'project.open-known';
      projectId: string;
    };

export type NativeMenuCommandId = NativeMenuCommand['commandId'];
