export interface WorkbenchShellFontSet {
  load(font: string, text?: string): PromiseLike<unknown>;
}

const WORKBENCH_SHELL_FONT_REQUESTS = [
  ['700 16px "Smiley Sans"', 'Debrute'],
  ['400 16px "Noto Sans SC"', 'Debrute 设置'],
  ['600 16px "Noto Sans SC"', 'Debrute 设置'],
  ['700 16px "Noto Sans SC"', 'Debrute 设置'],
  ['400 16px "Noto Sans Mono CJK SC"', 'Debrute 设置'],
  ['700 16px "Noto Sans Mono CJK SC"', 'Debrute 设置']
] as const;

export async function waitForWorkbenchShellFonts(fonts: WorkbenchShellFontSet): Promise<void> {
  await Promise.all(WORKBENCH_SHELL_FONT_REQUESTS.map(([font, text]) => fonts.load(font, text)));
}
