import type { WorkbenchApiClient } from '../../types';
import { createHttpWorkbenchApiClient } from '../../api/httpWorkbenchApiClient';

export function createWorkbenchApiClient(): WorkbenchApiClient {
  return createHttpWorkbenchApiClient();
}
