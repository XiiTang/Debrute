import type { RuntimeControlClient } from '@debrute/runtime-control-client';

type ProductQuitControl = Pick<RuntimeControlClient, 'quitProduct'>;

export class DesktopProductQuit {
  private requestRecorded = false;
  private requestSent = false;

  get requested(): boolean {
    return this.requestRecorded;
  }

  async request(control?: ProductQuitControl): Promise<void> {
    this.requestRecorded = true;
    if (!control || this.requestSent) {
      return;
    }
    this.requestSent = true;
    const response = await control.quitProduct();
    if (response.result === 'rejected') {
      throw new Error(`Runtime rejected Product Quit: ${response.code}`);
    }
    if (response.result !== 'ok') {
      throw new Error(`Runtime returned an unexpected Product Quit response: ${response.result}`);
    }
  }

  async sendRecordedRequest(control: ProductQuitControl): Promise<boolean> {
    if (!this.requestRecorded) {
      return false;
    }
    await this.request(control);
    return true;
  }
}
