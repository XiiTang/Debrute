import { AxisAppServer } from '@axis/app-server';

export interface CreateDesktopAppServerInput {
  integrationEnvPath: string;
}

export function createDesktopAppServer(input: CreateDesktopAppServerInput): AxisAppServer {
  return new AxisAppServer({
    integrationEnvPath: input.integrationEnvPath
  });
}
